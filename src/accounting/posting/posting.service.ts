/* eslint-disable prettier/prettier */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../../database/databaseservice';
import { RedisService } from '../../redis/redis.service';
import { PremiumPayment } from '../../premium/premium.schemas';
import { BASE_CURRENCY, BOOKS_START, type SourceType } from '../accounting.constants';
import { parseDay } from '../accounting.util';
import { AccountingService } from '../accounting.service';
import { AcctPostingState, AcctSourceMark, JournalEntry } from '../schemas/accounting.schemas';
import {
  convertDraftLines, postAddon, postPayoutCompleted, postPlanInvoice, postPlanRefund, postPremiumPayment, postSellerTx,
  type PostingDraft, type RuleResult,
} from './posting.rules';

/** Auto-posted source kinds the runner scans, in this order. */
export const RUNNER_SOURCES = ['seller_tx', 'payout_completed', 'platform_plan_invoice', 'platform_plan_refund', 'addon_purchase', 'premium_payment'] as const;
export type RunnerSource = (typeof RUNNER_SOURCES)[number];

const BATCH = 500;
const MAX_PER_RUN = 20_000; // per source per run; the next run carries on from the watermark
const LOCK_KEY = 'acct-posting-run';

export interface RunStats { posted: number; skipped: number; errors: number; ms: number }

/** Resolves "PKR per 1 unit of X" on a date from the append-only exchange_rates history (cached per run). */
class FxResolver {
  private cache = new Map<string, { ratePerUsd: number; fallback: boolean } | null>();
  constructor(private readonly db: DatabaseService) {}

  private async ratePerUsd(currency: string, date: Date) {
    if (currency === 'USD') return { ratePerUsd: 1, fallback: false };
    const key = `${currency}:${date.toISOString().slice(0, 10)}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = this.db.repositories.exchangeRateModel;
    const end = new Date(date.getTime());
    let row: any = await m.findOne({ currency, isRejected: false, effectiveFrom: { $lte: end } }).sort({ effectiveFrom: -1 }).lean();
    let fallback = false;
    if (!row) { row = await m.findOne({ currency, isRejected: false }).sort({ effectiveFrom: 1 }).lean(); fallback = !!row; }
    const out = row ? { ratePerUsd: Number(row.ratePerUSD), fallback } : null;
    this.cache.set(key, out);
    return out;
  }

  /** Base units per 1 unit of `currency` on `date`; throws when no rate exists at all. */
  async rate(currency: string, date: Date): Promise<{ fxRate: number; flag: string | null }> {
    const cur = currency.toUpperCase();
    if (cur === BASE_CURRENCY) return { fxRate: 1, flag: null };
    const from = await this.ratePerUsd(cur, date);
    const to = await this.ratePerUsd(BASE_CURRENCY, date);
    if (!from || !to || !(from.ratePerUsd > 0) || !(to.ratePerUsd > 0)) throw new Error(`No ${cur}/${BASE_CURRENCY} exchange rate on record`);
    const flag = from.fallback || to.fallback ? `FX: no rate on or before ${date.toISOString().slice(0, 10)}; the earliest known rate was used` : null;
    return { fxRate: to.ratePerUsd / from.ratePerUsd, flag };
  }
}

@Injectable()
export class PostingService {
  private readonly logger = new Logger(PostingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: AccountingService,
    @InjectModel(JournalEntry.name) private readonly journals: Model<JournalEntry>,
    @InjectModel(AcctSourceMark.name) private readonly marks: Model<AcctSourceMark>,
    @InjectModel(AcctPostingState.name) private readonly states: Model<AcctPostingState>,
    @InjectModel(PremiumPayment.name) private readonly premiumPayments: Model<PremiumPayment>,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /** Runs every source once. Safe on several instances: a Redis lock when available, and the unique source index always. */
  async runAll(opts: { from?: Date | null } = {}): Promise<Record<string, RunStats> | { skipped: 'locked' }> {
    let result: Record<string, RunStats> = {};
    const work = async () => { result = await this.runUnlocked(opts); };
    if (this.redis?.isConnected) {
      const r = await this.redis.withLock(LOCK_KEY, 30 * 60_000, work);
      if (r === 'lock_not_acquired') return { skipped: 'locked' };
    } else {
      await work();
    }
    return result;
  }

  private async runUnlocked(opts: { from?: Date | null }) {
    const out: Record<string, RunStats> = {};
    const fx = new FxResolver(this.db);
    for (const source of RUNNER_SOURCES) {
      const started = Date.now();
      const stats = { posted: 0, skipped: 0, errors: 0, ms: 0 };
      try {
        await this.runSource(source, fx, stats, opts.from ?? null);
      } catch (err: any) {
        stats.errors++;
        this.logger.error(`Posting ${source} failed: ${err?.message}`);
      }
      stats.ms = Date.now() - started;
      out[source] = stats;
      await this.states.updateOne({ sourceType: source }, { $set: { lastRunAt: new Date(), lastRun: stats } }, { upsert: true });
    }
    return out;
  }

  private async watermark(source: string, from: Date | null): Promise<Date> {
    const booksStart = parseDay(BOOKS_START)!;
    if (from) return from < booksStart ? booksStart : from;
    const st = await this.states.findOne({ sourceType: source }).lean();
    return st?.watermark && st.watermark > booksStart ? st.watermark : booksStart;
  }

  private async setWatermark(source: string, at: Date, backfill: boolean) {
    // A backfill never moves the regular watermark backwards.
    const st = await this.states.findOne({ sourceType: source }).lean();
    if (backfill && st?.watermark && st.watermark >= at) return;
    await this.states.updateOne({ sourceType: source }, { $set: { watermark: at } }, { upsert: true });
  }

  /**
   * Scans one source from its watermark: immutable rows (seller transactions, add-ons) by createdAt, rows whose
   * state changes later (payouts, invoices, Premium payments) by updatedAt. Previously failed rows are retried first.
   */
  private async runSource(source: RunnerSource, fx: FxResolver, stats: RunStats, from: Date | null) {
    await this.retryErrors(source, fx, stats);
    const since = await this.watermark(source, from);
    const booksStart = parseDay(BOOKS_START)!;
    const r = this.db.repositories;
    const field = source === 'seller_tx' || source === 'addon_purchase' ? 'createdAt' : 'updatedAt';
    const model: Model<any> =
      source === 'seller_tx' ? r.transactionModel
        : source === 'payout_completed' ? r.payoutModel
          : source === 'addon_purchase' ? r.platformAddonPurchaseModel
            : source === 'premium_payment' ? this.premiumPayments
              : r.platformPlanInvoiceModel;
    const filter: Record<string, any> = { [field]: { $gte: since } };
    if (source === 'payout_completed') filter.status = 'completed';
    if (source === 'platform_plan_invoice') { filter.status = { $in: ['paid', 'refunded', 'partially_refunded'] }; filter.paidAt = { $gte: booksStart }; }
    if (source === 'platform_plan_refund') { filter.refundedAmountUSD = { $gt: 0 }; filter.refundedAt = { $gte: booksStart }; }
    if (source === 'premium_payment') { filter.status = 'approved'; filter.reviewedAt = { $gte: booksStart }; }
    if (source === 'seller_tx' || source === 'addon_purchase') filter.createdAt = { $gte: since > booksStart ? since : booksStart };

    let cursorFrom = since;
    let seen = 0;
    let lastIds = new Set<string>();
    for (;;) {
      const page: any[] = await model.find({ ...filter, [field]: { ...(filter[field] ?? {}), $gte: cursorFrom } }).sort({ [field]: 1, _id: 1 }).limit(BATCH).lean();
      const fresh = page.filter((d) => !lastIds.has(String(d._id)));
      if (!fresh.length) break;
      await this.processBatch(source, fresh, fx, stats);
      seen += fresh.length;
      const lastAt: Date = page[page.length - 1][field];
      lastIds = new Set(page.filter((d) => String(d[field]) === String(lastAt)).map((d) => String(d._id)));
      cursorFrom = lastAt;
      await this.setWatermark(source, lastAt, !!from);
      if (page.length < BATCH || seen >= MAX_PER_RUN) break;
    }
  }

  private async retryErrors(source: RunnerSource, fx: FxResolver, stats: RunStats) {
    const errs = await this.marks.find({ sourceType: source, status: 'error', attempts: { $lt: 50 } }).limit(200).lean();
    if (!errs.length) return;
    const r = this.db.repositories;
    const ids = errs.map((e) => e.sourceId.split(':')[0]);
    const model: Model<any> =
      source === 'seller_tx' ? r.transactionModel : source === 'payout_completed' ? r.payoutModel : source === 'addon_purchase' ? r.platformAddonPurchaseModel
        : source === 'premium_payment' ? this.premiumPayments : r.platformPlanInvoiceModel;
    const docs = await model.find({ _id: { $in: ids } }).lean();
    await this.processBatch(source, docs, fx, stats);
  }

  // ── One batch ───────────────────────────────────────────────────────────────
  private async processBatch(source: RunnerSource, docs: any[], fx: FxResolver, stats: RunStats) {
    if (!docs.length) return;
    const ids = docs.map((d) => String(d._id));
    const done = new Set(
      (await this.journals.find({ 'source.type': source, 'source.id': { $in: source === 'platform_plan_refund' ? [] : ids } }).select('source.id').lean()).map((j: any) => j.source.id),
    );
    const skipped = new Set((await this.marks.find({ sourceType: source, sourceId: { $in: ids }, status: 'skipped' }).select('sourceId').lean()).map((m) => m.sourceId));
    const todo = docs.filter((d) => !done.has(String(d._id)) && !skipped.has(String(d._id)));
    if (!todo.length) return;
    const ctx = await this.loadContext(source, todo);
    for (const d of todo) {
      const id = String(d._id);
      try {
        const res = this.applyRule(source, d, ctx);
        if ('skip' in res) {
          if (source !== 'platform_plan_refund') await this.mark(source, id, 'skipped', res.skip, d.createdAt);
          stats.skipped++;
          continue;
        }
        const sourceId = source === 'platform_plan_refund' ? `${id}:${Math.round(Number(d.refundedAmountUSD) * 100)}` : id;
        await this.save(source, sourceId, res.post, fx);
        await this.marks.deleteOne({ sourceType: source, sourceId: id, status: 'error' });
        stats.posted++;
      } catch (err: any) {
        stats.errors++;
        await this.mark(source, id, 'error', String(err?.message ?? err).slice(0, 300), d.createdAt);
      }
    }
  }

  private async save(source: SourceType, sourceId: string, draft: PostingDraft, fx: FxResolver) {
    const { fxRate, flag } = await fx.rate(draft.currency, draft.date);
    const lines = convertDraftLines(draft, fxRate, BASE_CURRENCY);
    await this.ledger.postJournal({
      date: draft.date, memo: draft.memo, lines, kind: 'auto', preparedBy: 'system', approvedBy: 'system',
      source: { type: source, id: sourceId, ref: draft.ref }, flags: flag ? [flag] : [],
    });
  }

  private async mark(source: string, sourceId: string, status: 'skipped' | 'error', reason: string, sourceDate?: Date) {
    await this.marks.updateOne(
      { sourceType: source, sourceId },
      { $set: { status, reason, sourceDate: sourceDate ?? null }, $inc: { attempts: 1 } },
      { upsert: true },
    );
  }

  private applyRule(source: RunnerSource, d: any, ctx: Ctx): RuleResult {
    const storeName = (sid: string) => ctx.stores.get(String(sid))?.name ?? null;
    switch (source) {
      case 'seller_tx': {
        const key = `${d.storeId}:${d.referenceId}`;
        const order = d.referenceType === 'order' ? ctx.orders.get(String(d.referenceId)) : undefined;
        const sib = ctx.siblings.get(key);
        return postSellerTx(
          { ...d, _id: String(d._id) },
          {
            storeName: storeName(d.storeId), managementType: ctx.stores.get(String(d.storeId))?.managementType ?? null,
            saleMeta: sib?.saleMeta ?? null, paymentMethodType: sib?.paymentMethodType ?? null,
            customer: order?.userId ? { id: order.userId, name: ctx.users.get(order.userId) ?? null } : null, orderNumber: order?.orderNumber ?? null,
          },
        );
      }
      case 'payout_completed': return postPayoutCompleted({ ...d, _id: String(d._id) }, storeName(d.storeId));
      case 'platform_plan_invoice': return postPlanInvoice({ ...d, _id: String(d._id) }, storeName(d.storeId));
      case 'platform_plan_refund': return postPlanRefund({ ...d, _id: String(d._id) }, ctx.refundsPosted.get(String(d._id)) ?? 0, storeName(d.storeId));
      case 'addon_purchase': return postAddon({ ...d, _id: String(d._id) }, storeName(d.storeId));
      case 'premium_payment': return postPremiumPayment({ ...d, _id: String(d._id) }, ctx.users.get(String(d.userId)) ?? null);
    }
  }

  private async loadContext(source: RunnerSource, docs: any[]): Promise<Ctx> {
    const r = this.db.repositories;
    const ctx: Ctx = { stores: new Map(), siblings: new Map(), orders: new Map(), users: new Map(), refundsPosted: new Map() };
    const storeIds = [...new Set(docs.map((d) => d.storeId).filter(Boolean).map(String))];
    if (storeIds.length) {
      const stores: any[] = await r.storeModel.find({ _id: { $in: storeIds } }).select('name managementType').lean();
      for (const s of stores) ctx.stores.set(String(s._id), { name: s.name ?? null, managementType: s.managementType ?? null });
    }
    if (source === 'seller_tx') {
      const orderIds = [...new Set(docs.filter((d) => d.referenceType === 'order' && d.referenceId).map((d) => String(d.referenceId)))];
      if (orderIds.length) {
        const sibs: any[] = await r.transactionModel.find({ referenceType: 'order', referenceId: { $in: orderIds }, type: { $in: ['sale', 'fee'] } }).select('storeId referenceId type metadata').lean();
        for (const t of sibs) {
          const key = `${t.storeId}:${t.referenceId}`;
          const cur = ctx.siblings.get(key) ?? { saleMeta: null, paymentMethodType: null };
          if (t.type === 'sale') cur.saleMeta = t.metadata ?? null;
          if (t.metadata?.paymentMethodType) cur.paymentMethodType = t.metadata.paymentMethodType;
          ctx.siblings.set(key, cur);
        }
        const valid = orderIds.filter((id) => /^[a-f0-9]{24}$/i.test(id));
        const orders: any[] = valid.length ? await r.orderModel.find({ _id: { $in: valid } }).select('orderNumber userId').lean() : [];
        for (const o of orders) ctx.orders.set(String(o._id), { orderNumber: o.orderNumber ?? null, userId: o.userId ? String(o.userId) : null });
      }
    }
    const userIds = [
      ...[...ctx.orders.values()].map((o) => o.userId),
      ...(source === 'premium_payment' ? docs.map((d) => String(d.userId)) : []),
    ].filter((x): x is string => !!x && /^[a-f0-9]{24}$/i.test(x));
    if (userIds.length) {
      const users: any[] = await r.userModel.find({ _id: { $in: [...new Set(userIds)] } }).select('name email').lean();
      for (const u of users) ctx.users.set(String(u._id), u.name || u.email || null);
    }
    if (source === 'platform_plan_refund') {
      const ids = docs.map((d) => String(d._id));
      const rows = await this.journals.aggregate<{ _id: string; usd: number }>([
        { $match: { 'source.type': 'platform_plan_refund', status: 'posted' } },
        { $project: { inv: { $arrayElemAt: [{ $split: ['$source.id', ':'] }, 0] }, usd: { $arrayElemAt: ['$lines.amountOriginal', 0] } } },
        { $match: { inv: { $in: ids } } },
        { $group: { _id: '$inv', usd: { $sum: '$usd' } } },
      ]);
      for (const row of rows) ctx.refundsPosted.set(row._id, row.usd ?? 0);
    }
    return ctx;
  }

  // ── Status for the admin screen ─────────────────────────────────────────────
  async status() {
    const [states, counts, errors, skippedCounts] = await Promise.all([
      this.states.find({}).lean(),
      this.journals.aggregate<{ _id: string; n: number; total: number }>([{ $match: { kind: 'auto' } }, { $group: { _id: '$source.type', n: { $sum: 1 }, total: { $sum: '$total' } } }]),
      this.marks.find({ status: 'error' }).sort({ updatedAt: -1 }).limit(100).lean(),
      this.marks.aggregate<{ _id: string; n: number }>([{ $match: { status: 'skipped' } }, { $group: { _id: '$sourceType', n: { $sum: 1 } } }]),
    ]);
    const c = new Map(counts.map((x) => [x._id, x]));
    const s = new Map(states.map((x) => [x.sourceType, x]));
    const sk = new Map(skippedCounts.map((x) => [x._id, x.n]));
    return {
      booksStart: BOOKS_START,
      sources: [...RUNNER_SOURCES, 'depreciation'].map((k) => ({
        source: k, posted: c.get(k)?.n ?? 0, totalPkr: c.get(k)?.total ?? 0, skipped: sk.get(k) ?? 0,
        watermark: s.get(k)?.watermark ?? null, lastRunAt: s.get(k)?.lastRunAt ?? null, lastRun: s.get(k)?.lastRun ?? null,
        errors: errors.filter((e) => e.sourceType === k).length,
      })),
      errors: errors.map((e) => ({ source: e.sourceType, id: e.sourceId, reason: e.reason, attempts: e.attempts, at: (e as any).updatedAt })),
    };
  }
}

interface Ctx {
  stores: Map<string, { name: string | null; managementType: 'self' | 'managed' | null }>;
  siblings: Map<string, { saleMeta: Record<string, any> | null; paymentMethodType: string | null }>;
  orders: Map<string, { orderNumber: string | null; userId: string | null }>;
  users: Map<string, string | null>;
  refundsPosted: Map<string, number>;
}
