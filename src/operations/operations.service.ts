/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { ProductQuestion, ProductQuestionDocument } from '../classroom/schemas/product-question.schema';
import { StoreAssignment, StoreAssignmentDocument } from '../managed-stores/schemas/store-assignment.schema';
import { mouStatus, type MouStatus } from '../managed-stores/managed-stores.util';
import { dispatchDueAt } from '../common/dispatch.util';
import {
  healthOf, isOverdue, isStuck, isToShip, medianOf, parseSort, regionOf, shipmentKind, sortRows, storeCountry, weightedPct,
  UNANSWERED_HOURS, type HealthLevel, type OpenPackage, type Region, type ShipmentKind,
} from './operations.util';

/** Who is asking: every store, or only the stores assigned to this team member. */
export type OpsScope = { all: true } | { all: false; adminId: string };

const CACHE_SECONDS = 180;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const MAX_STORES = 3000;
const CHUNK = 5000;
const STORE_FIELDS = 'name slug status sellerId country managementType mou fulfillmentMode responseStats trustStats logo createdAt';
const OPEN_STATUSES = ['pending', 'processing', 'shipped'];

export interface OpsRow {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  status: string;
  country: string;
  region: Region;
  managementType: 'self' | 'managed';
  fulfillmentMode: 'seller' | 'platform';
  seller: { id: string; name: string | null; email: string | null } | null;
  mouStatus: MouStatus | null;
  commissionRate: number | null;
  assignees: { adminId: string; name: string | null; role: string }[];
  listings: { active: number; drafts: number; pendingReview: number; rejected: number; inactive: number; outOfStock: number; missingPhotos: number; issues: number };
  response: { medianReplyMinutes: number | null; responseRatePct: number | null; responseSample: number; unanswered: number; unansweredOver24h: number; oldestUnansweredAt: string | null; unansweredQuestions: number };
  orders: { new: number; toShip: number; overdue: number; inTransit: number; delivered30d: number; cancelledBySeller30d: number; returnsOpen: number };
  shipments: { inTransit: number; stuck: number; onTimeDispatchPct: number | null; dispatchSample: number; lateDispatchPct: number | null; domestic30d: number; crossBorder30d: number; unknown30d: number };
  health: { level: HealthLevel; reasons: string[] };
}

type Counter<K extends string> = Record<K, number>;
const zero = <K extends string>(keys: readonly K[]): Counter<K> => Object.fromEntries(keys.map((k) => [k, 0])) as Counter<K>;

@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @InjectModel(ProductQuestion.name) private readonly questionModel: Model<ProductQuestionDocument>,
    @InjectModel(StoreAssignment.name) private readonly assignmentModel: Model<StoreAssignmentDocument>,
  ) {}

  private get r() { return this.db.repositories; }

  /** Throws when a team member limited to assigned stores asks for a store that is not theirs. */
  async assertStoreInScope(scope: OpsScope, storeId: string) {
    if (scope.all) return;
    const ok = await this.assignmentModel.exists({ storeId, adminId: scope.adminId, active: true });
    if (!ok) throw new ForbiddenException('This store is not assigned to you.');
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  async overview(scope: OpsScope, query: Record<string, unknown>, now = new Date()) {
    const rows = await this.cachedRows(scope, query.refresh === '1' || query.refresh === 'true', now);

    const type = query.type === 'managed' || query.type === 'self' ? query.type : null;
    const region = query.region === 'national' || query.region === 'international' ? query.region : null;
    const manager = typeof query.manager === 'string' && /^[a-f0-9]{24}$/i.test(query.manager) ? query.manager : null;
    const attention = query.attention === '1' || query.attention === 'true';
    const level = query.level === 'action' || query.level === 'watch' || query.level === 'good' ? query.level : null;
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 80).toLowerCase() : '';

    const filtered = rows.filter((r) =>
      (!type || r.managementType === type) &&
      (!region || r.region === region) &&
      (!manager || r.assignees.some((a) => a.adminId === manager)) &&
      (!attention || r.health.level !== 'good') &&
      (!level || r.health.level === level) &&
      (!q || r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q) || (r.seller?.name ?? '').toLowerCase().includes(q) || (r.seller?.email ?? '').toLowerCase().includes(q)),
    );
    const sorted = sortRows(filtered, parseSort(query.sort));
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const page = Math.max(1, Number(query.page) || 1);

    const sum = (f: (r: OpsRow) => number) => filtered.reduce((n, r) => n + f(r), 0);
    const summary = {
      stores: filtered.length,
      needsAttention: filtered.filter((r) => r.health.level !== 'good').length,
      actionNeeded: filtered.filter((r) => r.health.level === 'action').length,
      overdueOrders: sum((r) => r.orders.overdue),
      toShip: sum((r) => r.orders.toShip),
      unansweredOver24h: sum((r) => r.response.unansweredOver24h),
      unansweredQuestions: sum((r) => r.response.unansweredQuestions),
      stuckShipments: sum((r) => r.shipments.stuck),
      inTransit: sum((r) => r.shipments.inTransit),
      listingIssues: sum((r) => r.listings.issues),
      medianReplyMinutes: medianOf(filtered.map((r) => r.response.medianReplyMinutes)),
      onTimeDispatchPct: weightedPct(filtered.map((r) => ({ pct: r.shipments.onTimeDispatchPct, sample: r.shipments.dispatchSample }))),
    };
    return {
      items: sorted.slice((page - 1) * limit, page * limit),
      total: filtered.length,
      page,
      limit,
      summary,
      counts: { all: rows.length, managed: rows.filter((r) => r.managementType === 'managed').length, international: rows.filter((r) => r.region === 'international').length },
      generatedAt: (rows as any).generatedAt ?? now.toISOString(),
      scope: scope.all ? 'all' : 'assigned',
    };
  }

  /** Every store in scope with its metrics, cached for 3 minutes per scope (filters/sort/paging run on the cached rows). */
  private async cachedRows(scope: OpsScope, refresh: boolean, now: Date): Promise<OpsRow[]> {
    const key = `ops:rows:${scope.all ? 'all' : `a:${scope.adminId}`}`;
    if (!refresh) {
      try {
        const hit = await this.redis.get(key);
        if (hit) {
          const parsed = JSON.parse(hit) as { at: string; rows: OpsRow[] };
          return Object.assign(parsed.rows, { generatedAt: parsed.at });
        }
      } catch { /* cache is optional */ }
    }
    const storeFilter: Record<string, unknown> = { isDelete: false };
    if (!scope.all) {
      const ids = (await this.assignmentModel.find({ adminId: scope.adminId, active: true }).select('storeId').lean()).map((a: any) => String(a.storeId));
      storeFilter._id = { $in: ids };
    }
    const stores: any[] = await this.r.storeModel.find(storeFilter).select(STORE_FIELDS).sort({ name: 1 }).limit(MAX_STORES).lean();
    const rows = await this.buildRows(stores, now);
    try { await this.redis.set(key, JSON.stringify({ at: now.toISOString(), rows }), CACHE_SECONDS); } catch (e: any) { this.logger.debug(`ops cache write failed: ${e?.message}`); }
    return Object.assign(rows, { generatedAt: now.toISOString() });
  }

  /** Metrics for many stores at once: one grouped query per source, never one query per store. */
  async buildRows(stores: any[], now = new Date()): Promise<OpsRow[]> {
    if (!stores.length) return [];
    const ids = stores.map((s) => String(s._id));
    const countryById = new Map(stores.map((s) => [String(s._id), storeCountry(s.country)]));
    const [sellers, assignments, listings, outOfStock, convs, questions, open, recent, returns] = await Promise.all([
      this.r.sellerModel.find({ _id: { $in: [...new Set(stores.map((s) => String(s.sellerId)).filter(Boolean))] } }).select('name email').lean(),
      this.assignmentModel.find({ storeId: { $in: ids }, active: true }).select('storeId adminId role').lean(),
      this.listingCounts(ids),
      this.outOfStockCounts(ids),
      this.unansweredChats(ids, now),
      this.questionCounts(ids),
      this.openPackages(ids, countryById, now),
      this.recentPackages(ids, countryById, now),
      this.openReturns(ids),
    ]);
    const adminIds = [...new Set(assignments.map((a: any) => String(a.adminId)))];
    const admins: any[] = adminIds.length ? await this.r.adminModel.find({ _id: { $in: adminIds } }).select('name email').lean() : [];
    const adminName = new Map(admins.map((a) => [String(a._id), a.name ?? a.email ?? null]));
    const sellerById = new Map((sellers as any[]).map((s) => [String(s._id), s]));

    return stores.map((s) => {
      const id = String(s._id);
      const seller = sellerById.get(String(s.sellerId));
      const managed = s.managementType === 'managed';
      const mou = managed || s.mou ? mouStatus(s.mou, now) : null;
      const l = listings.get(id) ?? zero(['active', 'drafts', 'pendingReview', 'rejected', 'inactive', 'missingPhotos'] as const);
      const oos = outOfStock.get(id) ?? 0;
      const c = convs.get(id) ?? { unanswered: 0, over24h: 0, oldest: null };
      const o = open.get(id) ?? zero(['new', 'toShip', 'overdue', 'inTransit', 'stuck'] as const);
      const rec = recent.get(id) ?? zero(['delivered', 'cancelledBySeller', 'domestic', 'crossBorder', 'unknown'] as const);
      const rate = s.trustStats?.responseRate;
      const dispatch = s.trustStats?.dispatch;
      const responseRatePct = typeof rate?.pct === 'number' ? rate.pct : null;
      const onTimeDispatchPct = typeof dispatch?.pct === 'number' ? dispatch.pct : null;
      const lateDispatchPct = onTimeDispatchPct === null ? null : 100 - onTimeDispatchPct;
      const row: OpsRow = {
        id,
        name: String(s.name ?? ''),
        slug: String(s.slug ?? ''),
        logo: s.logo ?? null,
        status: String(s.status ?? ''),
        country: storeCountry(s.country),
        region: regionOf(s.country),
        managementType: managed ? 'managed' : 'self',
        fulfillmentMode: s.fulfillmentMode === 'platform' ? 'platform' : 'seller',
        seller: seller ? { id: String(seller._id), name: seller.name ?? null, email: seller.email ?? null } : null,
        mouStatus: mou,
        commissionRate: managed && typeof s.mou?.commissionRate === 'number' ? s.mou.commissionRate : null,
        assignees: (assignments as any[]).filter((a) => String(a.storeId) === id).map((a) => ({ adminId: String(a.adminId), name: adminName.get(String(a.adminId)) ?? null, role: a.role })),
        listings: { ...l, outOfStock: oos, issues: l.rejected + l.missingPhotos + oos },
        response: {
          medianReplyMinutes: typeof s.responseStats?.medianReplyMinutes === 'number' ? s.responseStats.medianReplyMinutes : null,
          responseRatePct,
          responseSample: Number(rate?.sample) || 0,
          unanswered: c.unanswered,
          unansweredOver24h: c.over24h,
          oldestUnansweredAt: c.oldest ? new Date(c.oldest).toISOString() : null,
          unansweredQuestions: questions.get(id) ?? 0,
        },
        orders: { new: o.new, toShip: o.toShip, overdue: o.overdue, inTransit: o.inTransit, delivered30d: rec.delivered, cancelledBySeller30d: rec.cancelledBySeller, returnsOpen: returns.get(id) ?? 0 },
        shipments: {
          inTransit: o.inTransit, stuck: o.stuck, onTimeDispatchPct, dispatchSample: Number(dispatch?.sample) || 0, lateDispatchPct,
          domestic30d: rec.domestic, crossBorder30d: rec.crossBorder, unknown30d: rec.unknown,
        },
        health: { level: 'good', reasons: [] },
      };
      row.health = healthOf({
        overdueOrders: row.orders.overdue, unansweredOver24h: row.response.unansweredOver24h, stuckShipments: row.shipments.stuck,
        mouStatus: managed ? mou : null, responseRatePct, lateDispatchPct,
      });
      return row;
    });
  }

  // ── Sources (each grouped by store) ─────────────────────────────────────────

  private async listingCounts(ids: string[]) {
    const rows: any[] = await this.r.productModel.aggregate([
      { $match: { storeId: { $in: ids }, isDelete: false } },
      {
        $group: {
          _id: '$storeId',
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          drafts: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
          pendingReview: { $sum: { $cond: [{ $eq: ['$status', 'pending_review'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
          inactive: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } },
          // Only listings buyers see (or are about to) need photos; an unfinished draft is not an issue yet.
          missingPhotos: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['active', 'pending_review']] }, { $eq: [{ $size: { $ifNull: ['$images', []] } }, 0] }] }, 1, 0] } },
        },
      },
    ]).allowDiskUse(true);
    return new Map(rows.map((r) => [String(r._id), { active: r.active, drafts: r.drafts, pendingReview: r.pendingReview, rejected: r.rejected, inactive: r.inactive, missingPhotos: r.missingPhotos }]));
  }

  /** Live physical listings with no stock: no unlimited variant and variant stock adds up to 0 (same rule as Inventory). */
  private async outOfStockCounts(ids: string[]): Promise<Map<string, number>> {
    const products: any[] = await this.r.productModel.find({ storeId: { $in: ids }, isDelete: false, type: 'physical', status: 'active' }).select('_id storeId').lean();
    const stock = await this.variantStock(products.map((p) => String(p._id)));
    const out = new Map<string, number>();
    for (const p of products) {
      const v = stock.get(String(p._id));
      if (v?.unlimited || (v?.stock ?? 0) > 0) continue;
      out.set(String(p.storeId), (out.get(String(p.storeId)) ?? 0) + 1);
    }
    return out;
  }

  private async variantStock(productIds: string[]) {
    const out = new Map<string, { stock: number; unlimited: boolean }>();
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const rows: any[] = await this.r.productVariantModel.aggregate([
        { $match: { productId: { $in: productIds.slice(i, i + CHUNK) }, isDelete: { $ne: true } } },
        { $group: { _id: '$productId', stock: { $sum: { $cond: [{ $eq: ['$unlimitedStock', true] }, 0, { $ifNull: ['$stock', 0] }] } }, unlimited: { $max: { $cond: [{ $eq: ['$unlimitedStock', true] }, 1, 0] } } } },
      ]);
      for (const r of rows) out.set(String(r._id), { stock: r.stock, unlimited: r.unlimited === 1 });
    }
    return out;
  }

  /** Conversations whose latest message is from the buyer (nobody has answered yet). */
  private async unansweredChats(ids: string[], now: Date) {
    const cutoff = new Date(now.getTime() - UNANSWERED_HOURS * 3_600_000);
    const rows: any[] = await this.r.conversationModel.aggregate([
      { $match: { storeId: { $in: ids }, 'lastMessage.senderRole': 'user', deletedBySeller: { $ne: true }, isArchived: { $ne: true }, blockedBySeller: { $ne: true } } },
      {
        $group: {
          _id: '$storeId',
          unanswered: { $sum: 1 },
          over24h: { $sum: { $cond: [{ $lt: ['$lastMessage.sentAt', cutoff] }, 1, 0] } },
          oldest: { $min: '$lastMessage.sentAt' },
        },
      },
    ]);
    return new Map(rows.map((r) => [String(r._id), { unanswered: r.unanswered, over24h: r.over24h, oldest: r.oldest ?? null }]));
  }

  private async questionCounts(ids: string[]) {
    const rows: any[] = await this.questionModel.aggregate([
      { $match: { storeId: { $in: ids }, answeredAt: null, hidden: false } },
      { $group: { _id: '$storeId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n as number]));
  }

  /** Packages still moving (pending / processing / shipped), any age. */
  private async openPackages(ids: string[], countryById: Map<string, string>, now: Date) {
    const rows = await this.openPackageRows(ids);
    const out = new Map<string, Counter<'new' | 'toShip' | 'overdue' | 'inTransit' | 'stuck'>>();
    for (const r of rows) {
      const c = out.get(r.storeId) ?? zero(['new', 'toShip', 'overdue', 'inTransit', 'stuck'] as const);
      if (r.status === 'pending') c.new++;
      if (isToShip(r)) c.toShip++;
      if (isOverdue(r, now)) c.overdue++;
      if (r.status === 'shipped') {
        c.inTransit++;
        if (isStuck(r.shippedAt, shipmentKind(countryById.get(r.storeId), r.buyerCountry), now)) c.stuck++;
      }
      out.set(r.storeId, c);
    }
    return out;
  }

  private async openPackageRows(ids: string[], extra: Record<string, unknown> = {}): Promise<(OpenPackage & { storeId: string; orderId: string; orderNumber: string; buyerCountry: string | null; buyerCity: string | null; createdAt: Date; courier: string | null; trackingNumber: string | null; mode: string })[]> {
    const rows: any[] = await this.r.orderModel.aggregate([
      { $match: { isDelete: { $ne: true }, isFreeClaim: { $ne: true }, sellerOrders: { $elemMatch: { storeId: { $in: ids }, status: { $in: OPEN_STATUSES } } }, ...extra } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': { $in: ids }, 'sellerOrders.status': { $in: OPEN_STATUSES } } },
      {
        $project: {
          _id: 0, orderId: '$_id', orderNumber: 1, createdAt: 1,
          storeId: '$sellerOrders.storeId', status: '$sellerOrders.status', fulfillmentType: '$sellerOrders.fulfillmentType',
          mode: '$sellerOrders.fulfillmentMode', dispatchDays: '$sellerOrders.dispatchDays', shippedAt: '$sellerOrders.shippedAt',
          payable: { $or: [{ $eq: ['$isPaid', true] }, { $eq: ['$paymentType', 'cash_on_delivery'] }, { $eq: ['$sellerOrders.isPaid', true] }] },
          baseAt: { $ifNull: ['$paidAt', '$createdAt'] },
          buyerCountry: { $ifNull: ['$shippingAddress.country', null] },
          buyerCity: { $ifNull: ['$shippingAddress.city', null] },
          courier: { $ifNull: ['$sellerOrders.shipment.courier', { $ifNull: ['$sellerOrders.tracking.carrier', { $ifNull: ['$sellerOrders.shippingCourier.courier', null] }] }] },
          trackingNumber: { $ifNull: ['$sellerOrders.shipment.trackingNumber', { $ifNull: ['$sellerOrders.tracking.trackingNumber', null] }] },
        },
      },
    ]).allowDiskUse(true);
    return rows.map((r) => ({ ...r, storeId: String(r.storeId), orderId: String(r.orderId), dispatchDays: r.dispatchDays ?? null, shippedAt: r.shippedAt ?? null, mode: r.mode ?? 'seller' }));
  }

  /** Physical packages created in the last 30 days: delivered, seller cancellations, domestic vs cross-border. */
  private async recentPackages(ids: string[], countryById: Map<string, string>, now: Date) {
    const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const rows: any[] = await this.r.orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': { $in: ids }, createdAt: { $gte: since }, isDelete: { $ne: true }, isFreeClaim: { $ne: true } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': { $in: ids }, 'sellerOrders.fulfillmentType': { $in: ['physical', 'mixed'] } } },
      {
        $group: {
          _id: { storeId: '$sellerOrders.storeId', country: { $ifNull: ['$shippingAddress.country', null] } },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $in: ['$sellerOrders.status', ['delivered', 'completed']] }, 1, 0] } },
          cancelledBySeller: { $sum: { $cond: [{ $and: [{ $eq: ['$sellerOrders.status', 'cancelled'] }, { $eq: ['$sellerOrders.cancelledBy', 'seller'] }] }, 1, 0] } },
        },
      },
    ]).allowDiskUse(true);
    const out = new Map<string, Counter<'delivered' | 'cancelledBySeller' | 'domestic' | 'crossBorder' | 'unknown'>>();
    for (const r of rows) {
      const storeId = String(r._id.storeId);
      const c = out.get(storeId) ?? zero(['delivered', 'cancelledBySeller', 'domestic', 'crossBorder', 'unknown'] as const);
      c.delivered += r.delivered;
      c.cancelledBySeller += r.cancelledBySeller;
      const kind: ShipmentKind = shipmentKind(countryById.get(storeId), r._id.country);
      if (kind === 'domestic') c.domestic += r.total;
      else if (kind === 'cross_border') c.crossBorder += r.total;
      else c.unknown += r.total;
      out.set(storeId, c);
    }
    return out;
  }

  /** Items with a return request still waiting for the seller (requested / partly requested). */
  private async openReturns(ids: string[]) {
    const rows: any[] = await this.r.orderModel.aggregate([
      { $match: { 'sellerOrders.items.returnStatus': { $in: ['requested', 'partial_requested'] }, 'sellerOrders.storeId': { $in: ids }, isDelete: { $ne: true } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': { $in: ids } } },
      { $unwind: '$sellerOrders.items' },
      { $match: { 'sellerOrders.items.returnStatus': { $in: ['requested', 'partial_requested'] } } },
      { $group: { _id: '$sellerOrders.storeId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n as number]));
  }

  // ── Store detail ────────────────────────────────────────────────────────────

  async detail(scope: OpsScope, storeId: string, now = new Date()) {
    await this.assertStoreInScope(scope, storeId);
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select(`${STORE_FIELDS} dispatchDays`).lean();
    if (!store) throw new NotFoundException('Store not found');
    const [row] = await this.buildRows([store], now);
    const country = storeCountry(store.country);

    const [open, chats, listingIssues, assignments] = await Promise.all([
      this.openPackageRows([storeId]),
      this.r.conversationModel
        .find({ storeId, 'lastMessage.senderRole': 'user', deletedBySeller: { $ne: true }, isArchived: { $ne: true }, blockedBySeller: { $ne: true } })
        .select('buyerId lastMessage.sentAt contextProductId contextOrderId')
        .sort({ 'lastMessage.sentAt': 1 })
        .limit(50)
        .lean(),
      this.listingIssues(storeId),
      this.assignmentModel.find({ storeId, active: true }).select('adminId role assignedAt').lean(),
    ]);

    const overdue = open
      .filter((p) => isOverdue(p, now))
      .map((p) => {
        const due = dispatchDueAt(p.baseAt as Date, p.dispatchDays);
        return { orderId: p.orderId, orderNumber: p.orderNumber, status: p.status, buyerCountry: p.buyerCountry, buyerCity: p.buyerCity, createdAt: p.createdAt, dueAt: due, hoursLate: Math.floor((now.getTime() - due.getTime()) / 3_600_000), shippedBy: p.mode === 'platform' ? 'edudeen' : 'seller' };
      })
      .sort((a, b) => b.hoursLate - a.hoursLate)
      .slice(0, 50);

    const stuck = open
      .filter((p) => p.status === 'shipped')
      .map((p) => ({ p, kind: shipmentKind(country, p.buyerCountry) }))
      .filter(({ p, kind }) => isStuck(p.shippedAt, kind, now))
      .map(({ p, kind }) => ({ orderId: p.orderId, orderNumber: p.orderNumber, courier: p.courier, trackingNumber: p.trackingNumber, shippedAt: p.shippedAt, days: Math.floor((now.getTime() - new Date(p.shippedAt as Date).getTime()) / DAY_MS), kind, buyerCountry: p.buyerCountry }))
      .sort((a, b) => b.days - a.days)
      .slice(0, 50);

    const buyerIds = [...new Set((chats as any[]).map((c) => String(c.buyerId)))];
    const buyers: any[] = buyerIds.length ? await this.r.userModel.find({ _id: { $in: buyerIds } }).select('name').lean() : [];
    const buyerName = new Map(buyers.map((b) => [String(b._id), b.name ?? null]));
    const unanswered = (chats as any[]).map((c) => ({
      conversationId: String(c._id),
      // First name only: enough to recognise the chat; the full conversation stays behind the support permission.
      buyer: (buyerName.get(String(c.buyerId)) ?? 'Buyer').split(' ')[0],
      waitingSince: c.lastMessage?.sentAt ?? null,
      hoursWaiting: c.lastMessage?.sentAt ? Math.floor((now.getTime() - new Date(c.lastMessage.sentAt).getTime()) / 3_600_000) : null,
      aboutOrderId: c.contextOrderId ?? null,
      aboutProductId: c.contextProductId ?? null,
    }));

    const adminIds = (assignments as any[]).map((a) => String(a.adminId));
    const admins: any[] = adminIds.length ? await this.r.adminModel.find({ _id: { $in: adminIds } }).select('name email').lean() : [];
    const adminById = new Map(admins.map((a) => [String(a._id), a]));

    return {
      store: row,
      mou: row.managementType === 'managed' || store.mou ? {
        status: row.mouStatus, commissionRate: store.mou?.commissionRate ?? null, startDate: store.mou?.startDate ?? null, endDate: store.mou?.endDate ?? null, hasDocument: !!store.mou?.document?.publicId,
      } : null,
      assignees: (assignments as any[]).map((a) => ({ adminId: String(a.adminId), role: a.role, assignedAt: a.assignedAt, name: adminById.get(String(a.adminId))?.name ?? null, email: adminById.get(String(a.adminId))?.email ?? null })),
      overdueOrders: overdue,
      stuckShipments: stuck,
      unansweredChats: unanswered,
      listingIssues,
      generatedAt: now.toISOString(),
    };
  }

  private async listingIssues(storeId: string) {
    const [rejected, missingPhotos, active] = await Promise.all([
      this.r.productModel.find({ storeId, isDelete: false, status: 'rejected' }).select('name reviewNote reviewedAt').sort({ reviewedAt: -1 }).limit(20).lean(),
      this.r.productModel.find({ storeId, isDelete: false, status: { $in: ['active', 'pending_review'] }, $or: [{ images: { $exists: false } }, { images: { $size: 0 } }] }).select('name status').limit(20).lean(),
      this.r.productModel.find({ storeId, isDelete: false, type: 'physical', status: 'active' }).select('name').lean(),
    ]);
    const stock = await this.variantStock((active as any[]).map((p) => String(p._id)));
    const outOfStock = (active as any[]).filter((p) => { const v = stock.get(String(p._id)); return !(v?.unlimited || (v?.stock ?? 0) > 0); }).slice(0, 20);
    return {
      rejected: (rejected as any[]).map((p) => ({ productId: String(p._id), name: p.name, note: p.reviewNote ? String(p.reviewNote).slice(0, 160) : null, reviewedAt: p.reviewedAt ?? null })),
      missingPhotos: (missingPhotos as any[]).map((p) => ({ productId: String(p._id), name: p.name, status: p.status })),
      outOfStock: outOfStock.map((p) => ({ productId: String(p._id), name: p.name })),
    };
  }

  /** Team members (for the manager filter): everyone with at least one active store assignment. */
  async managers(scope: OpsScope) {
    const filter: Record<string, unknown> = { active: true };
    if (!scope.all) filter.adminId = scope.adminId;
    const rows: any[] = await this.assignmentModel.aggregate([{ $match: filter }, { $group: { _id: '$adminId', stores: { $sum: 1 } } }]);
    const admins: any[] = rows.length ? await this.r.adminModel.find({ _id: { $in: rows.map((r) => r._id) } }).select('name email').lean() : [];
    const byId = new Map(admins.map((a) => [String(a._id), a]));
    return rows
      .map((r) => ({ adminId: String(r._id), name: byId.get(String(r._id))?.name ?? null, email: byId.get(String(r._id))?.email ?? null, stores: r.stores }))
      .sort((a, b) => String(a.name ?? a.email).localeCompare(String(b.name ?? b.email)));
  }
}
