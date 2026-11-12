/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RedisService } from '../redis/redis.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { Order } from '../orders/schemas/order.schema';
import { Product } from '../products/schemas/product.schema';
import { Store } from '../store/schemas/store.schema';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { resolveDateRange } from '../analytics/utils/analytics-date.util';
import { paidPeriodTotals } from '../analytics/utils/order-aggregation.util';
import { StoreFollower } from '../store/schemas/store-follower.schema';
import { HighlightDaily, TermDaily, VisitDaily } from './visit-daily.schema';
import {
  COUNTER_TTL_SECONDS, HIGHLIGHT_ROWS, VISIT_DEDUPE_SECONDS, VISIT_SOURCES, VisitSource,
  conversionRate, counterKey, dedupeKey, highlightKey, isBotUserAgent, isHex24, parseCounterKey, parseHighlightKey, parseTermKey,
  pktDateOf, pktDayStartOf, sanitizeHighlightRow, sanitizeSource, sanitizeTerm, sessionHash, termKey, visitSecret,
} from './visit-tracking.util';

export type RecordViewInput = { ip: string; ua: string; type: unknown; id: unknown; source?: unknown; term?: unknown; row?: unknown; now?: Date };

@Injectable()
export class VisitsService {
  private readonly logger = new Logger(VisitsService.name);
  /** productId -> storeId (null = unknown/deleted/test). Small in-process cache so a busy product does not hit Mongo per view. */
  private productStore = new Map<string, string | null>();

  constructor(
    private readonly redis: RedisService,
    @InjectModel(VisitDaily.name) private readonly visitModel: Model<VisitDaily>,
    @InjectModel(TermDaily.name) private readonly termModel: Model<TermDaily>,
    @InjectModel(Order.name) private readonly orderModel: Model<any>,
    @InjectModel(Product.name) private readonly productModel: Model<any>,
    @InjectModel(Store.name) private readonly storeModel: Model<any>,
    @Optional() private readonly entitlements?: EntitlementsService,
    @Optional() @InjectModel(HighlightDaily.name) private readonly highlightModel?: Model<HighlightDaily>,
    @Optional() @InjectModel(StoreFollower.name) private readonly followerModel?: Model<any>,
  ) {}

  // ── Recording (public beacon) ───────────────────────────────────────────
  /** Never throws. Returns true only when a new visit was counted (used by tests). Redis down / bot / bad input = silently dropped. */
  async record(input: RecordViewInput): Promise<boolean> {
    try {
      return await this.recordInner(input);
    } catch {
      return false;
    }
  }

  private async recordInner(input: RecordViewInput): Promise<boolean> {
    if (input.type === 'highlight_click') return this.recordHighlightClick(input);
    const kind = input.type === 'store' ? 'store' : input.type === 'product' ? 'product' : null;
    if (!kind || !isHex24(input.id)) return false;
    if (isBotUserAgent(input.ua)) return false;
    if (!this.redis.isConnected) return false;

    const pktDate = pktDateOf(input.now ?? new Date());
    const hash = sessionHash(input.ip || '', input.ua, pktDate, visitSecret());
    const source: VisitSource = sanitizeSource(input.source);
    const term = source === 'edudeen_search' ? sanitizeTerm(input.term) : null;

    if (kind === 'store') {
      const fresh = await this.redis.setNx(dedupeKey(hash, 'store', input.id), VISIT_DEDUPE_SECONDS);
      if (!fresh) return false; // repeat within 30 min (or Redis went away)
      await this.countStoreVisit(pktDate, input.id, source, term);
      return true;
    }

    // product page view: dedupe per product first, then resolve its store
    const fresh = await this.redis.setNx(dedupeKey(hash, 'product', input.id), VISIT_DEDUPE_SECONDS);
    if (!fresh) return false;
    const storeId = await this.storeOfProduct(input.id);
    if (!storeId) return false;
    await this.redis.incrBy(counterKey(pktDate, storeId, input.id, source), 1, COUNTER_TTL_SECONDS);
    // the same session also counts once as a visit to the store
    const storeFresh = await this.redis.setNx(dedupeKey(hash, 'store', storeId), VISIT_DEDUPE_SECONDS);
    if (storeFresh) await this.countStoreVisit(pktDate, storeId, source, term);
    return true;
  }

  /** A buyer opened a product from one of the store page's highlight rows. `id` = the product; its store is resolved here
   *  (a client can never credit a different store). Same anonymous session hash + 30 min dedupe as visits, per (row, product). */
  private async recordHighlightClick(input: RecordViewInput): Promise<boolean> {
    const row = sanitizeHighlightRow(input.row);
    if (!row || !isHex24(input.id)) return false;
    if (isBotUserAgent(input.ua)) return false;
    if (!this.redis.isConnected) return false;
    const pktDate = pktDateOf(input.now ?? new Date());
    const hash = sessionHash(input.ip || '', input.ua, pktDate, visitSecret());
    const storeId = await this.storeOfProduct(input.id);
    if (!storeId) return false;
    const fresh = await this.redis.setNx(dedupeKey(hash, 'hl', `${row}:${input.id}`), VISIT_DEDUPE_SECONDS);
    if (!fresh) return false;
    await this.redis.incrBy(highlightKey(pktDate, storeId, row), 1, COUNTER_TTL_SECONDS);
    return true;
  }

  private async countStoreVisit(pktDate: string, storeId: string, source: VisitSource, term: string | null) {
    await this.redis.incrBy(counterKey(pktDate, storeId, null, source), 1, COUNTER_TTL_SECONDS);
    if (term) await this.redis.incrBy(termKey(pktDate, storeId, term), 1, COUNTER_TTL_SECONDS);
  }

  private async storeOfProduct(productId: string): Promise<string | null> {
    if (this.productStore.has(productId)) return this.productStore.get(productId)!;
    const p: any = await this.productModel.findOne({ _id: productId, isDelete: { $ne: true }, isTest: { $ne: true } }).select('storeId').lean();
    const storeId = p?.storeId ? String(p.storeId) : null;
    if (this.productStore.size > 5000) this.productStore.clear();
    this.productStore.set(productId, storeId);
    return storeId;
  }

  // ── Rollup: Redis counters -> daily collection ──────────────────────────
  @Cron('* * * * *')
  async cronRollup() {
    try {
      const r = await this.redis.withLock('cron-lock:analytics-visits-rollup', 55_000, async () => { await this.rollup(); });
      if (r === 'lock_not_acquired') this.logger.debug('Skipped visit rollup (lock held or Redis down)');
    } catch (err: any) {
      this.logger.error(`Visit rollup failed: ${err?.message}`);
    }
  }

  /** Moves every counter into Mongo with $inc. A failed write puts the counts back so nothing is lost. */
  async rollup(): Promise<{ visitRows: number; termRows: number }> {
    const counters: { key: string; n: number; parsed: NonNullable<ReturnType<typeof parseCounterKey>> }[] = [];
    for (const key of await this.redis.scanKeys('av:c:*')) {
      const parsed = parseCounterKey(key);
      if (!parsed) continue;
      const n = Number(await this.redis.getDel(key));
      if (Number.isFinite(n) && n > 0) counters.push({ key, n, parsed });
    }
    const terms: { key: string; n: number; parsed: NonNullable<ReturnType<typeof parseTermKey>> }[] = [];
    for (const key of await this.redis.scanKeys('av:t:*')) {
      const parsed = parseTermKey(key);
      if (!parsed) continue;
      const n = Number(await this.redis.getDel(key));
      if (Number.isFinite(n) && n > 0) terms.push({ key, n, parsed });
    }
    const clicks: { key: string; n: number; parsed: NonNullable<ReturnType<typeof parseHighlightKey>> }[] = [];
    for (const key of await this.redis.scanKeys('av:h:*')) {
      const parsed = parseHighlightKey(key);
      if (!parsed) continue;
      const n = Number(await this.redis.getDel(key));
      if (Number.isFinite(n) && n > 0) clicks.push({ key, n, parsed });
    }
    if (!counters.length && !terms.length && !clicks.length) return { visitRows: 0, termRows: 0 };

    try {
      const ids = [...new Set([...counters.map((c) => c.parsed.storeId), ...terms.map((t) => t.parsed.storeId), ...clicks.map((c) => c.parsed.storeId)])];
      const found = new Set((await this.storeModel.find({ _id: { $in: ids } }).select('_id').lean()).map((s: any) => String(s._id)));
      const vOps = counters.filter((c) => found.has(c.parsed.storeId)).map((c) => ({
        updateOne: {
          filter: { storeId: c.parsed.storeId, productId: c.parsed.productId ?? '', pktDate: c.parsed.pktDate, source: c.parsed.source },
          update: { $inc: { visits: c.n } },
          upsert: true,
        },
      }));
      const tOps = terms.filter((t) => found.has(t.parsed.storeId)).map((t) => ({
        updateOne: {
          filter: { storeId: t.parsed.storeId, pktDate: t.parsed.pktDate, term: t.parsed.term },
          update: { $inc: { visits: t.n } },
          upsert: true,
        },
      }));
      if (vOps.length) await this.visitModel.bulkWrite(vOps as any, { ordered: false });
      if (tOps.length) await this.termModel.bulkWrite(tOps as any, { ordered: false });
      const hOps = clicks.filter((c) => found.has(c.parsed.storeId)).map((c) => ({
        updateOne: {
          filter: { storeId: c.parsed.storeId, pktDate: c.parsed.pktDate, row: c.parsed.row },
          update: { $inc: { clicks: c.n } },
          upsert: true,
        },
      }));
      if (hOps.length && this.highlightModel) await this.highlightModel.bulkWrite(hOps as any, { ordered: false });
      return { visitRows: vOps.length, termRows: tOps.length };
    } catch (err) {
      for (const c of counters) await this.redis.incrBy(c.key, c.n, COUNTER_TTL_SECONDS).catch(() => undefined);
      for (const t of terms) await this.redis.incrBy(t.key, t.n, COUNTER_TTL_SECONDS).catch(() => undefined);
      for (const h of clicks) await this.redis.incrBy(h.key, h.n, COUNTER_TTL_SECONDS).catch(() => undefined);
      throw err;
    }
  }

  // ── Seller read ─────────────────────────────────────────────────────────
  async getStats(sellerId: string, storeId: string | undefined, query: { range?: string; from?: string; to?: string }) {
    if (!isHex24(storeId)) throw new BadRequestException('storeId is required');
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const { from, to } = resolveDateRange(query, { pkt: true });
    const fromDate = pktDateOf(from);
    const toDate = pktDateOf(to);

    const first: any = await this.visitModel.findOne({ storeId }).sort({ pktDate: 1 }).select('pktDate').lean();
    const trackingSince: string | null = first?.pktDate ?? null;

    const bySource = await this.visitModel.aggregate([
      { $match: { storeId, productId: '', pktDate: { $gte: fromDate, $lte: toDate } } },
      { $group: { _id: '$source', visits: { $sum: '$visits' } } },
    ]);
    const visits = bySource.reduce((s: number, r: any) => s + r.visits, 0);

    // Orders from before we started counting visits would inflate the rate, so count orders only from the first tracked day.
    let paidOrders = 0;
    if (trackingSince) {
      const effFrom = new Date(Math.max(from.getTime(), pktDayStartOf(trackingSince).getTime()));
      if (effFrom.getTime() <= to.getTime()) {
        paidOrders = (await paidPeriodTotals(this.orderModel, effFrom, to, { 'sellerOrders.storeId': storeId })).orderCount;
      }
    }

    const proAllowed = this.entitlements ? !!(await this.entitlements.getLimits(storeId)).advancedAnalyticsAllowed : true;
    let pro: { allowed: boolean; sources?: { source: string; visits: number; percent: number }[]; terms?: { term: string; visits: number }[] } = { allowed: proAllowed };
    if (proAllowed) {
      const map = new Map<string, number>(bySource.map((r: any) => [r._id, r.visits]));
      const sources = VISIT_SOURCES.map((source) => {
        const v = map.get(source) ?? 0;
        return { source, visits: v, percent: visits > 0 ? Math.round((v / visits) * 1000) / 10 : 0 };
      });
      const terms = await this.termModel.aggregate([
        { $match: { storeId, pktDate: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: '$term', visits: { $sum: '$visits' } } },
        { $sort: { visits: -1, _id: 1 } },
        { $limit: 10 },
      ]);
      pro = { allowed: true, sources, terms: terms.map((t: any) => ({ term: t._id, visits: t.visits })) };
    }

    return {
      success: true,
      data: {
        range: { from: fromDate, to: toDate },
        trackingSince,
        visits,
        paidOrders,
        conversionRate: conversionRate(paidOrders, visits),
        pro,
      },
    };
  }

  /** Customize Store insights (free for every plan): store visits, new followers and highlight-row clicks, last 7 or 30 PKT days. */
  async getPageInsights(sellerId: string, storeId: string | undefined, days: unknown) {
    if (!isHex24(storeId)) throw new BadRequestException('storeId is required');
    const d = days === undefined || days === '' ? 7 : Number(days);
    if (d !== 7 && d !== 30) throw new BadRequestException('days must be 7 or 30');
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const { from, to } = resolveDateRange({ range: d === 7 ? '7d' : '30d' }, { pkt: true });
    const fromDate = pktDateOf(from);
    const toDate = pktDateOf(to);

    const first: any = await this.visitModel.findOne({ storeId }).sort({ pktDate: 1 }).select('pktDate').lean();
    const [visitRows, clickRows, newFollowers] = await Promise.all([
      this.visitModel.aggregate([
        { $match: { storeId, productId: '', pktDate: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, visits: { $sum: '$visits' } } },
      ]),
      this.highlightModel
        ? this.highlightModel.aggregate([
            { $match: { storeId, pktDate: { $gte: fromDate, $lte: toDate } } },
            { $group: { _id: '$row', clicks: { $sum: '$clicks' } } },
          ])
        : Promise.resolve([] as any[]),
      // follow records carry their creation time; someone who unfollowed again is no longer a record, so this is NET new followers
      this.followerModel ? this.followerModel.countDocuments({ storeId, createdAt: { $gte: from, $lte: to } }) : Promise.resolve(0),
    ]);
    const byRow = Object.fromEntries(HIGHLIGHT_ROWS.map((r) => [r, (clickRows as any[]).find((x) => x._id === r)?.clicks ?? 0])) as Record<(typeof HIGHLIGHT_ROWS)[number], number>;
    return {
      success: true,
      data: {
        days: d,
        range: { from: fromDate, to: toDate },
        trackingSince: first?.pktDate ?? null,
        visits: (visitRows as any[])[0]?.visits ?? 0,
        newFollowers,
        highlightClicks: { total: HIGHLIGHT_ROWS.reduce((s, r) => s + byRow[r], 0), byRow },
      },
    };
  }

  // ── Admin read (platform-wide, every store) ─────────────────────────────
  async getAdminStats(query: { range?: string; from?: string; to?: string }) {
    const { from, to } = resolveDateRange(query, { pkt: true });
    const fromDate = pktDateOf(from);
    const toDate = pktDateOf(to);

    const first: any = await this.visitModel.findOne({}).sort({ pktDate: 1 }).select('pktDate').lean();
    const trackingSince: string | null = first?.pktDate ?? null;

    const [bySource, byDay, topStores] = await Promise.all([
      this.visitModel.aggregate([
        { $match: { productId: '', pktDate: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: '$source', visits: { $sum: '$visits' } } },
      ]),
      this.visitModel.aggregate([
        { $match: { productId: '', pktDate: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: '$pktDate', visits: { $sum: '$visits' } } },
        { $sort: { _id: 1 } },
      ]),
      this.visitModel.aggregate([
        { $match: { productId: '', pktDate: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: '$storeId', visits: { $sum: '$visits' } } },
        { $sort: { visits: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const visits = bySource.reduce((s: number, r: any) => s + r.visits, 0);
    const sources = VISIT_SOURCES.map((source) => {
      const v = (bySource.find((r: any) => r._id === source) as any)?.visits ?? 0;
      return { source, visits: v, percent: visits > 0 ? Math.round((v / visits) * 1000) / 10 : 0 };
    });

    const storeIds = topStores.map((r: any) => r._id).filter(Boolean);
    const stores = storeIds.length
      ? await this.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean()
      : [];
    const storeById = new Map(stores.map((s: any) => [String(s._id), s]));
    const stores_: { storeId: string; name: string; slug: string | null; visits: number }[] = topStores.map((r: any) => ({
      storeId: r._id,
      name: (storeById.get(String(r._id)) as any)?.name ?? 'Unknown store',
      slug: (storeById.get(String(r._id)) as any)?.slug ?? null,
      visits: r.visits,
    }));

    // Same "only count orders from the first tracked day" rule as the seller view,
    // just without a storeId filter — platform-wide conversion.
    let paidOrders = 0;
    if (trackingSince) {
      const effFrom = new Date(Math.max(from.getTime(), pktDayStartOf(trackingSince).getTime()));
      if (effFrom.getTime() <= to.getTime()) {
        paidOrders = (await paidPeriodTotals(this.orderModel, effFrom, to, {})).orderCount;
      }
    }

    return {
      success: true,
      data: {
        range: { from: fromDate, to: toDate },
        trackingSince,
        visits,
        paidOrders,
        conversionRate: conversionRate(paidOrders, visits),
        sources,
        byDay: byDay.map((r: any) => ({ date: r._id, visits: r.visits })),
        topStores: stores_,
      },
    };
  }
}
