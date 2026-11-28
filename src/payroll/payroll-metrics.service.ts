/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { JournalEntry } from '../accounting/schemas/accounting.schemas';
import { round2 } from '../accounting/accounting.util';
import { StoreAssignment, StoreAssignmentDocument } from '../managed-stores/schemas/store-assignment.schema';
import { actionKind, pairFirstReplies, pct, shippedOnTime, REPLY_TARGET_MINUTES, type ChatMessage } from '../operations/team.util';
import { emptyCounts, monthBounds, type MetricCounts, type PerfFigures } from './payroll.util';
import { PayrollClaim, PayrollClaimDocument } from './schemas/payroll.schemas';

const DAY_MS = 86_400_000;
/** A buyer message this long before the month can still be answered inside it. */
const LOOKBACK_DAYS = 30;
const CHUNK = 2000;
/** Managed-store MOU commission income account (accounting.constants SEED_ACCOUNTS). */
const MOU_COMMISSION_ACCOUNT = '4010';

export interface MonthMetrics { counts: MetricCounts; perf: PerfFigures }

const emptyPerf = (): PerfFigures => ({
  on_time_pct: null, on_time_sample: 0, reply_within_24h_pct: null, reply_sample: 0, orders_handled: 0, products_listed: 0, sellers_onboarded: 0, support_replies: 0,
});

/**
 * What each team member did in one calendar month (UTC), from the attribution recorded in manage-as-seller
 * sessions (Phase 1) and the payroll claims. Definitions:
 *  - products_listed: listings they created (Product.createdByStaffId) that month.
 *  - products_edited: listings whose LATEST edit was theirs that month (only the last editor is recorded).
 *  - shipments_handled: distinct packages they marked shipped or booked a courier for.
 *  - orders_confirmed: distinct packages they confirmed (moved to processing/confirmed).
 *  - support_replies / replies_within_24h: their first answers to waiting buyers (same pairing as Team
 *    performance), and how many came within 24 h.
 *  - sellers_onboarded: stores they created for a seller in the admin panel (Store.createdByAdmin) that month.
 *  - managed_store_commission: Edudeen's MOU commission income (ledger account 4010, credits - debits) that month
 *    from stores where they were an ACCOUNT MANAGER on the journal date. Two account managers on one store both
 *    count the full amount; set rates accordingly.
 *  - visits: quantity of their APPROVED visit claims dated that month.
 */
@Injectable()
export class PayrollMetricsService {
  constructor(
    private readonly db: DatabaseService,
    @InjectModel(JournalEntry.name) private readonly journals: Model<JournalEntry>,
    @InjectModel(StoreAssignment.name) private readonly assignments: Model<StoreAssignmentDocument>,
    @InjectModel(PayrollClaim.name) private readonly claims: Model<PayrollClaimDocument>,
  ) {}

  private get r() { return this.db.repositories; }

  async forMonth(month: string, adminIds: string[], until?: Date): Promise<Map<string, MonthMetrics>> {
    const out = new Map<string, MonthMetrics>();
    const ids = [...new Set(adminIds.map(String))];
    for (const id of ids) out.set(id, { counts: emptyCounts(), perf: emptyPerf() });
    if (!ids.length) return out;
    const b = monthBounds(month);
    const start = b.start;
    const end = until && until < b.end ? until : b.end;
    const get = (id: string) => out.get(String(id));

    const [created, edited, onboarded, visits] = await Promise.all([
      this.r.productModel.aggregate([
        { $match: { createdByStaffId: { $in: ids }, createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: '$createdByStaffId', n: { $sum: 1 } } },
      ]),
      this.r.productModel.aggregate([
        { $match: { lastEditedByStaffId: { $in: ids }, lastEditedByStaffAt: { $gte: start, $lt: end } } },
        { $group: { _id: '$lastEditedByStaffId', n: { $sum: 1 } } },
      ]),
      this.r.storeModel.aggregate([
        { $match: { 'createdByAdmin.adminId': { $in: ids }, 'createdByAdmin.at': { $gte: start, $lt: end }, isDelete: { $ne: true } } },
        { $group: { _id: '$createdByAdmin.adminId', n: { $sum: 1 } } },
      ]),
      this.claims.aggregate([
        { $match: { adminId: { $in: ids }, type: 'visit', status: 'approved', date: { $gte: start, $lt: end } } },
        { $group: { _id: '$adminId', n: { $sum: { $ifNull: ['$quantity', 1] } } } },
      ]),
    ]);
    for (const r of created) { const m = get(r._id); if (m) { m.counts.products_listed = r.n; m.perf.products_listed = r.n; } }
    for (const r of edited) { const m = get(r._id); if (m) m.counts.products_edited = r.n; }
    for (const r of onboarded) { const m = get(r._id); if (m) { m.counts.sellers_onboarded = r.n; m.perf.sellers_onboarded = r.n; } }
    for (const r of visits) { const m = get(r._id); if (m) m.counts.visits = r.n; }

    await Promise.all([this.orders(ids, start, end, get), this.replies(ids, start, end, get), this.mouCommission(ids, start, end, get)]);
    return out;
  }

  private async orders(ids: string[], start: Date, end: Date, get: (id: string) => MonthMetrics | undefined) {
    const rows: any[] = await this.r.orderModel.aggregate([
      { $match: { 'sellerOrders.staffActions.at': { $gte: start, $lt: end } } },
      { $unwind: '$sellerOrders' },
      { $unwind: '$sellerOrders.staffActions' },
      { $match: { 'sellerOrders.staffActions.at': { $gte: start, $lt: end }, 'sellerOrders.staffActions.staffId': { $in: ids } } },
      { $project: {
        _id: 0, orderId: '$_id', storeId: '$sellerOrders.storeId', staffId: '$sellerOrders.staffActions.staffId', action: '$sellerOrders.staffActions.action',
        at: '$sellerOrders.staffActions.at', shippedAt: '$sellerOrders.shippedAt', dispatchDays: '$sellerOrders.dispatchDays', baseAt: { $ifNull: ['$paidAt', '$createdAt'] },
      } },
    ]).allowDiskUse(true);
    const handled = new Map<string, Set<string>>();
    const shipped = new Map<string, Set<string>>();
    const confirmed = new Map<string, Set<string>>();
    const timed = new Map<string, { ok: number; n: number }>();
    const add = (m: Map<string, Set<string>>, id: string, key: string) => { const s = m.get(id) ?? new Set(); s.add(key); m.set(id, s); };
    for (const r of rows) {
      const id = String(r.staffId);
      const key = `${String(r.orderId)}:${String(r.storeId)}`;
      add(handled, id, key);
      const kind = actionKind(String(r.action));
      if (kind === 'confirmed') add(confirmed, id, key);
      if (kind === 'shipped' || kind === 'courier_booked') add(shipped, id, key);
      if (kind === 'shipped') {
        const ok = shippedOnTime(r.baseAt, r.dispatchDays ?? null, r.shippedAt ?? r.at);
        if (ok !== null) { const t = timed.get(id) ?? { ok: 0, n: 0 }; t.n++; if (ok) t.ok++; timed.set(id, t); }
      }
    }
    for (const id of ids) {
      const m = get(id);
      if (!m) continue;
      m.counts.shipments_handled = shipped.get(id)?.size ?? 0;
      m.counts.orders_confirmed = confirmed.get(id)?.size ?? 0;
      m.perf.orders_handled = handled.get(id)?.size ?? 0;
      const t = timed.get(id);
      m.perf.on_time_sample = t?.n ?? 0;
      m.perf.on_time_pct = t ? pct(t.ok, t.n) : null;
    }
  }

  private async replies(ids: string[], start: Date, end: Date, get: (id: string) => MonthMetrics | undefined) {
    const sent: any[] = await this.r.messageModel.aggregate([
      { $match: { actingStaffId: { $in: ids }, createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$conversationId' } },
    ]);
    if (!sent.length) return;
    const convIds = sent.map((r) => String(r._id));
    const from = new Date(start.getTime() - LOOKBACK_DAYS * DAY_MS);
    const history: ChatMessage[] = [];
    for (let i = 0; i < convIds.length; i += CHUNK) {
      const part: any[] = await this.r.messageModel.aggregate([
        { $match: { conversationId: { $in: convIds.slice(i, i + CHUNK) }, createdAt: { $gte: from, $lt: end }, isDeleted: { $ne: true } } },
        { $project: { _id: 0, conversationId: 1, senderRole: 1, actingStaffId: 1, createdAt: 1 } },
      ]);
      history.push(...part.map((m) => ({ conversationId: String(m.conversationId), senderRole: String(m.senderRole), actingStaffId: m.actingStaffId ?? null, createdAt: m.createdAt })));
    }
    const tally = new Map<string, { n: number; fast: number }>();
    for (const reply of pairFirstReplies(history)) {
      const t = reply.repliedAt.getTime();
      if (t < start.getTime() || t >= end.getTime()) continue;
      const x = tally.get(reply.staffId) ?? { n: 0, fast: 0 };
      x.n++;
      if (reply.minutes <= REPLY_TARGET_MINUTES) x.fast++;
      tally.set(reply.staffId, x);
    }
    for (const [id, x] of tally) {
      const m = get(id);
      if (!m) continue;
      m.counts.support_replies = x.n;
      m.counts.replies_within_24h = x.fast;
      m.perf.support_replies = x.n;
      m.perf.reply_sample = x.n;
      m.perf.reply_within_24h_pct = pct(x.fast, x.n);
    }
  }

  private async mouCommission(ids: string[], start: Date, end: Date, get: (id: string) => MonthMetrics | undefined) {
    const assigned: any[] = await this.assignments.find({
      adminId: { $in: ids }, role: 'account_manager', assignedAt: { $lt: end },
      $or: [{ active: true }, { removedAt: { $gte: start } }],
    }).select('adminId storeId assignedAt removedAt active').lean();
    if (!assigned.length) return;
    const storeIds = [...new Set(assigned.map((a) => String(a.storeId)))];
    const rows: any[] = await this.journals.aggregate([
      { $match: { status: 'posted', date: { $gte: start, $lt: end }, 'lines.accountCode': MOU_COMMISSION_ACCOUNT } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': MOU_COMMISSION_ACCOUNT, 'lines.storeId': { $in: storeIds } } },
      { $project: { _id: 0, date: 1, storeId: '$lines.storeId', amount: { $subtract: ['$lines.credit', '$lines.debit'] } } },
    ]);
    const total = new Map<string, number>();
    for (const r of rows) {
      const at = new Date(r.date).getTime();
      for (const a of assigned) {
        if (String(a.storeId) !== String(r.storeId)) continue;
        if (new Date(a.assignedAt).getTime() > at) continue;
        if (!a.active && a.removedAt && new Date(a.removedAt).getTime() < at) continue;
        total.set(String(a.adminId), round2((total.get(String(a.adminId)) ?? 0) + Number(r.amount || 0)));
      }
    }
    for (const [id, n] of total) { const m = get(id); if (m) m.counts.managed_store_commission = Math.max(0, n); }
  }
}

