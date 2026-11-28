/* eslint-disable prettier/prettier */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { StoreAssignment, StoreAssignmentDocument } from '../managed-stores/schemas/store-assignment.schema';
import { StaffAudit, StaffAuditDocument } from '../staff/staff.schemas';
import { OperationsService, type OpsRow } from './operations.service';
import {
  actionKind, describeStoreWrite, inWindow, median, pairFirstReplies, parsePeriod, pct, shippedOnTime, teamBreaches, windowStart,
  REPLY_TARGET_MINUTES, type ChatMessage, type TeamPeriod,
} from './team.util';

const CACHE_SECONDS = 180;
const DAY_MS = 86_400_000;
/** A buyer message this long before the window can still be answered inside it. */
const LOOKBACK_DAYS = 30;
const MAX_CONVERSATIONS = 20_000;
const CHUNK = 2000;
const TIMELINE_PAGE = 25;

/** What one team member did in one store during the period. */
interface Tally {
  productsCreated: number;
  productsEdited: number;
  messagesSent: number;
  replyMinutes: number[];
  ordersActioned: Set<string>;
  confirmed: number;
  shipped: number;
  delivered: number;
  courierBooked: number;
  cancelled: number;
  shippedOnTime: number;
  shippedTimed: number;
}
const emptyTally = (): Tally => ({
  productsCreated: 0, productsEdited: 0, messagesSent: 0, replyMinutes: [], ordersActioned: new Set(),
  confirmed: 0, shipped: 0, delivered: 0, courierBooked: 0, cancelled: 0, shippedOnTime: 0, shippedTimed: 0,
});

export interface TeamRow {
  adminId: string;
  name: string | null;
  email: string | null;
  stores: { assigned: number; managed: number };
  products: { created: number; edited: number };
  replies: { sent: number; answered: number; medianMinutes: number | null; within24hPct: number | null };
  orders: { actioned: number; confirmed: number; shipped: number; delivered: number; courierBooked: number; cancelled: number; onTimePct: number | null; onTimeSample: number };
  workload: { toShip: number; overdue: number; waiting: number; waitingOver24h: number; stuck: number; listingIssues: number };
  lastActiveAt: string | null;
  breaches: string[];
}

interface Computed {
  rows: TeamRow[];
  /** adminId -> storeId -> tally */
  perStore: Map<string, Map<string, Tally>>;
  assigned: Map<string, { storeId: string; role: string; assignedAt: Date | null }[]>;
  opsById: Map<string, OpsRow>;
}

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ops: OperationsService,
    @InjectModel(StoreAssignment.name) private readonly assignmentModel: Model<StoreAssignmentDocument>,
    @InjectModel(StaffAudit.name) private readonly auditModel: Model<StaffAuditDocument>,
  ) {}

  private get r() { return this.db.repositories; }

  /** Every team member with assigned stores or manage-as-seller work in the period. Cached 3 minutes per period. */
  async team(query: Record<string, unknown>, now = new Date()) {
    const days = parsePeriod(query.days);
    const key = `ops:team:${days}`;
    const refresh = query.refresh === '1' || query.refresh === 'true';
    if (!refresh) {
      try {
        const hit = await this.redis.get(key);
        if (hit) return JSON.parse(hit) as { days: number; items: TeamRow[]; summary: Record<string, unknown>; generatedAt: string };
      } catch { /* cache is optional */ }
    }
    const { rows } = await this.compute(days, now);
    const answered = rows.reduce((n, r) => n + r.replies.answered, 0);
    const onTimeSample = rows.reduce((n, r) => n + r.orders.onTimeSample, 0);
    const out = {
      days,
      items: rows,
      summary: {
        members: rows.length,
        withBreaches: rows.filter((r) => r.breaches.length).length,
        productsListed: rows.reduce((n, r) => n + r.products.created, 0),
        repliesAnswered: answered,
        // Weighted by how many chats each member answered.
        medianReplyMinutes: median(rows.flatMap((r) => (r.replies.medianMinutes === null ? [] : Array<number>(Math.min(r.replies.answered, 500)).fill(r.replies.medianMinutes)))),
        ordersActioned: rows.reduce((n, r) => n + r.orders.actioned, 0),
        onTimePct: onTimeSample ? Math.round(rows.reduce((n, r) => n + (r.orders.onTimePct ?? 0) * r.orders.onTimeSample, 0) / onTimeSample) : null,
        openOverdue: rows.reduce((n, r) => n + r.workload.overdue, 0),
      },
      generatedAt: now.toISOString(),
    };
    try { await this.redis.set(key, JSON.stringify(out), CACHE_SECONDS); } catch (e: any) { this.logger.debug(`team cache write failed: ${e?.message}`); }
    return out;
  }

  /** One team member: totals, per-store breakdown and a paginated timeline of their store changes. */
  async member(adminId: string, query: Record<string, unknown>, now = new Date()) {
    const days = parsePeriod(query.days);
    const admin: any = await this.r.adminModel.findById(adminId).select('name email').lean();
    if (!admin) throw new NotFoundException('Team member not found');
    const { rows, perStore, assigned, opsById } = await this.compute(days, now, adminId);
    const row: TeamRow = rows[0] ?? this.blankRow(adminId, admin);

    const tallies = perStore.get(adminId) ?? new Map<string, Tally>();
    const mine = assigned.get(adminId) ?? [];
    const storeIds = [...new Set([...mine.map((a) => a.storeId), ...tallies.keys()])];
    const missing = storeIds.filter((id) => !opsById.has(id));
    const extra: any[] = missing.length ? await this.r.storeModel.find({ _id: { $in: missing } }).select('name slug managementType').lean() : [];
    const extraById = new Map(extra.map((s) => [String(s._id), s]));

    const stores = storeIds.map((storeId) => {
      const o = opsById.get(storeId);
      const t = tallies.get(storeId) ?? emptyTally();
      const a = mine.find((x) => x.storeId === storeId);
      return {
        storeId,
        name: o?.name ?? extraById.get(storeId)?.name ?? 'Store',
        managementType: o?.managementType ?? (extraById.get(storeId)?.managementType === 'managed' ? 'managed' : 'self'),
        assigned: !!a,
        role: a?.role ?? null,
        assignedAt: a?.assignedAt ?? null,
        health: o?.health ?? null,
        workload: o ? { toShip: o.orders.toShip, overdue: o.orders.overdue, waiting: o.response.unanswered, waitingOver24h: o.response.unansweredOver24h, stuck: o.shipments.stuck, listingIssues: o.listings.issues } : null,
        activity: {
          productsCreated: t.productsCreated, productsEdited: t.productsEdited, messagesSent: t.messagesSent,
          answered: t.replyMinutes.length, medianReplyMinutes: median(t.replyMinutes),
          ordersActioned: t.ordersActioned.size, shipped: t.shipped, onTimePct: pct(t.shippedOnTime, t.shippedTimed),
        },
      };
    }).sort((x, y) => Number(y.assigned) - Number(x.assigned) || x.name.localeCompare(y.name));

    const timeline = await this.timeline(adminId, Number(query.page) || 1);
    return { days, member: row, stores, timeline, generatedAt: now.toISOString() };
  }

  /** The member's 30-day reply median and on-time % (header of their own work queue). */
  async ownKpis(adminId: string, now = new Date()) {
    const { rows } = await this.compute(30, now, adminId);
    const r = rows[0];
    return { medianReplyMinutes: r?.replies.medianMinutes ?? null, within24hPct: r?.replies.within24hPct ?? null, onTimePct: r?.orders.onTimePct ?? null, onTimeSample: r?.orders.onTimeSample ?? 0 };
  }

  // ── Computation ────────────────────────────────────────────────────────────

  async compute(days: TeamPeriod, now: Date, onlyAdminId?: string): Promise<Computed> {
    const since = windowStart(days, now);
    const staffMatch = onlyAdminId ? onlyAdminId : { $type: 'string' };

    const assignmentRows: any[] = await this.assignmentModel.find({ active: true, ...(onlyAdminId ? { adminId: onlyAdminId } : {}) }).select('storeId adminId role assignedAt').lean();
    const assigned = new Map<string, { storeId: string; role: string; assignedAt: Date | null }[]>();
    for (const a of assignmentRows) {
      const list = assigned.get(String(a.adminId)) ?? [];
      list.push({ storeId: String(a.storeId), role: a.role, assignedAt: a.assignedAt ?? null });
      assigned.set(String(a.adminId), list);
    }

    const perStore = new Map<string, Map<string, Tally>>();
    const tally = (adminId: string, storeId: string): Tally => {
      let byStore = perStore.get(adminId);
      if (!byStore) { byStore = new Map(); perStore.set(adminId, byStore); }
      let t = byStore.get(storeId);
      if (!t) { t = emptyTally(); byStore.set(storeId, t); }
      return t;
    };

    await Promise.all([
      this.collectProducts(staffMatch, since, tally),
      this.collectMessages(staffMatch, since, now, tally),
      this.collectOrders(staffMatch, since, now, tally),
    ]);

    const adminIds = [...new Set([...assigned.keys(), ...perStore.keys()])].filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const [admins, lastActive, opsRows] = await Promise.all([
      adminIds.length ? this.r.adminModel.find({ _id: { $in: adminIds } }).select('name email').lean() : Promise.resolve([]),
      this.lastActive(adminIds),
      this.ops.cachedRows({ all: true }, false, now),
    ]);
    const adminById = new Map((admins as any[]).map((a) => [String(a._id), a]));
    const opsById = new Map(opsRows.map((o) => [o.id, o]));

    const rows: TeamRow[] = adminIds.filter((id) => adminById.has(id)).map((adminId) => {
      const tallies = [...(perStore.get(adminId)?.values() ?? [])];
      const sum = (f: (t: Tally) => number) => tallies.reduce((n, t) => n + f(t), 0);
      const minutes = tallies.flatMap((t) => t.replyMinutes);
      const mine = assigned.get(adminId) ?? [];
      const myOps = mine.map((a) => opsById.get(a.storeId)).filter((o): o is OpsRow => !!o);
      const wsum = (f: (o: OpsRow) => number) => myOps.reduce((n, o) => n + f(o), 0);
      const timed = sum((t) => t.shippedTimed);
      const a = adminById.get(adminId);
      const row: TeamRow = {
        adminId,
        name: a?.name ?? null,
        email: a?.email ?? null,
        stores: { assigned: mine.length, managed: myOps.filter((o) => o.managementType === 'managed').length },
        products: { created: sum((t) => t.productsCreated), edited: sum((t) => t.productsEdited) },
        replies: {
          sent: sum((t) => t.messagesSent),
          answered: minutes.length,
          medianMinutes: median(minutes),
          within24hPct: pct(minutes.filter((m) => m <= REPLY_TARGET_MINUTES).length, minutes.length),
        },
        orders: {
          actioned: sum((t) => t.ordersActioned.size),
          confirmed: sum((t) => t.confirmed),
          shipped: sum((t) => t.shipped),
          delivered: sum((t) => t.delivered),
          courierBooked: sum((t) => t.courierBooked),
          cancelled: sum((t) => t.cancelled),
          onTimePct: pct(sum((t) => t.shippedOnTime), timed),
          onTimeSample: timed,
        },
        workload: {
          toShip: wsum((o) => o.orders.toShip),
          overdue: wsum((o) => o.orders.overdue),
          waiting: wsum((o) => o.response.unanswered),
          waitingOver24h: wsum((o) => o.response.unansweredOver24h),
          stuck: wsum((o) => o.shipments.stuck),
          listingIssues: wsum((o) => o.listings.issues),
        },
        lastActiveAt: lastActive.get(adminId)?.toISOString() ?? null,
        breaches: [],
      };
      row.breaches = teamBreaches({
        medianReplyMinutes: row.replies.medianMinutes, onTimeDispatchPct: row.orders.onTimePct,
        openOverdue: row.workload.overdue, openWaitingOver24h: row.workload.waitingOver24h, openStuck: row.workload.stuck,
      });
      return row;
    }).sort((x, y) => y.breaches.length - x.breaches.length || String(x.name ?? x.email).localeCompare(String(y.name ?? y.email)));

    return { rows, perStore, assigned, opsById };
  }

  /** Listings a team member added, and listings whose latest edit was theirs (only the last editor is kept). */
  private async collectProducts(staffMatch: unknown, since: Date, tally: (a: string, s: string) => Tally) {
    const [created, edited] = await Promise.all([
      this.r.productModel.aggregate([
        { $match: { createdByStaffId: staffMatch, createdAt: { $gte: since } } },
        { $group: { _id: { a: '$createdByStaffId', s: '$storeId' }, n: { $sum: 1 } } },
      ]),
      this.r.productModel.aggregate([
        { $match: { lastEditedByStaffId: staffMatch, lastEditedByStaffAt: { $gte: since } } },
        { $group: { _id: { a: '$lastEditedByStaffId', s: '$storeId' }, n: { $sum: 1 } } },
      ]),
    ]);
    for (const r of created) tally(String(r._id.a), String(r._id.s)).productsCreated += r.n;
    for (const r of edited) tally(String(r._id.a), String(r._id.s)).productsEdited += r.n;
  }

  /** Messages sent by team members, and how fast their first answers to waiting buyers came. */
  private async collectMessages(staffMatch: unknown, since: Date, now: Date, tally: (a: string, s: string) => Tally) {
    const sent: any[] = await this.r.messageModel.aggregate([
      { $match: { actingStaffId: staffMatch, createdAt: { $gte: since } } },
      { $group: { _id: { a: '$actingStaffId', c: '$conversationId' }, n: { $sum: 1 } } },
      { $limit: MAX_CONVERSATIONS },
    ]);
    if (!sent.length) return;
    const convIds = [...new Set(sent.map((r) => String(r._id.c)))];
    const convs: any[] = await this.r.conversationModel.find({ _id: { $in: convIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)) } }).select('storeId').lean();
    const storeOf = new Map(convs.map((c) => [String(c._id), String(c.storeId)]));
    for (const r of sent) {
      const storeId = storeOf.get(String(r._id.c));
      if (storeId) tally(String(r._id.a), storeId).messagesSent += r.n;
    }

    // Full conversation history around the window (aggregation sees the select:false actingStaffId field).
    const from = new Date(since.getTime() - LOOKBACK_DAYS * DAY_MS);
    const history: ChatMessage[] = [];
    for (let i = 0; i < convIds.length; i += CHUNK) {
      const part: any[] = await this.r.messageModel.aggregate([
        { $match: { conversationId: { $in: convIds.slice(i, i + CHUNK) }, createdAt: { $gte: from }, isDeleted: { $ne: true } } },
        { $project: { _id: 0, conversationId: 1, senderRole: 1, actingStaffId: 1, createdAt: 1 } },
      ]);
      history.push(...part.map((m) => ({ conversationId: String(m.conversationId), senderRole: String(m.senderRole), actingStaffId: m.actingStaffId ?? null, createdAt: m.createdAt })));
    }
    const onlyId = typeof staffMatch === 'string' ? staffMatch : null;
    for (const reply of pairFirstReplies(history)) {
      if (onlyId && reply.staffId !== onlyId) continue;
      if (!inWindow(reply.repliedAt, since, now)) continue;
      const storeId = storeOf.get(reply.conversationId);
      if (storeId) tally(reply.staffId, storeId).replyMinutes.push(reply.minutes);
    }
  }

  /** Package steps (confirm, ship, courier booking, cancel) and whether the parcels they shipped left on time. */
  private async collectOrders(staffMatch: unknown, since: Date, now: Date, tally: (a: string, s: string) => Tally) {
    const rows: any[] = await this.r.orderModel.aggregate([
      { $match: { 'sellerOrders.staffActions.at': { $gte: since } } },
      { $unwind: '$sellerOrders' },
      { $unwind: '$sellerOrders.staffActions' },
      { $match: { 'sellerOrders.staffActions.at': { $gte: since }, 'sellerOrders.staffActions.staffId': staffMatch } },
      {
        $project: {
          _id: 0,
          orderId: '$_id',
          storeId: '$sellerOrders.storeId',
          staffId: '$sellerOrders.staffActions.staffId',
          action: '$sellerOrders.staffActions.action',
          at: '$sellerOrders.staffActions.at',
          shippedAt: '$sellerOrders.shippedAt',
          dispatchDays: '$sellerOrders.dispatchDays',
          baseAt: { $ifNull: ['$paidAt', '$createdAt'] },
        },
      },
    ]).allowDiskUse(true);
    for (const r of rows) {
      if (!inWindow(r.at, since, now)) continue;
      const t = tally(String(r.staffId), String(r.storeId));
      t.ordersActioned.add(`${String(r.orderId)}:${String(r.storeId)}`);
      const kind = actionKind(String(r.action));
      if (kind === 'confirmed') t.confirmed++;
      else if (kind === 'delivered') t.delivered++;
      else if (kind === 'courier_booked') t.courierBooked++;
      else if (kind === 'cancelled') t.cancelled++;
      else if (kind === 'shipped') {
        t.shipped++;
        const ok = shippedOnTime(r.baseAt, r.dispatchDays ?? null, r.shippedAt ?? r.at);
        if (ok !== null) { t.shippedTimed++; if (ok) t.shippedOnTime++; }
      }
    }
  }

  /** Latest manage-as-seller write or admin-panel change per team member. */
  private async lastActive(adminIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (!adminIds.length) return out;
    const [writes, audits] = await Promise.all([
      this.r.activityLogModel.aggregate([
        { $match: { actorId: { $in: adminIds }, action: 'admin_act_as_write' } },
        { $group: { _id: '$actorId', at: { $max: '$createdAt' } } },
      ]),
      this.auditModel.aggregate([
        { $match: { adminId: { $in: adminIds } } },
        { $group: { _id: '$adminId', at: { $max: '$at' } } },
      ]),
    ]);
    for (const r of [...writes, ...audits]) {
      if (!r.at) continue;
      const prev = out.get(String(r._id));
      if (!prev || new Date(r.at) > prev) out.set(String(r._id), new Date(r.at));
    }
    return out;
  }

  /** Every logged change the member made inside a store (manage-as-seller writes), newest first. */
  private async timeline(adminId: string, page: number) {
    const p = Math.max(1, Math.floor(page));
    const filter = { actorId: adminId, action: 'admin_act_as_write' };
    const [items, total] = await Promise.all([
      this.r.activityLogModel.find(filter).select('storeId metadata createdAt').sort({ createdAt: -1 }).skip((p - 1) * TIMELINE_PAGE).limit(TIMELINE_PAGE).lean(),
      this.r.activityLogModel.countDocuments(filter),
    ]);
    const storeIds = [...new Set((items as any[]).map((i) => String(i.storeId)).filter((id) => /^[a-f0-9]{24}$/i.test(id)))];
    const stores: any[] = storeIds.length ? await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean() : [];
    const storeName = new Map(stores.map((s) => [String(s._id), s.name]));
    return {
      items: (items as any[]).map((i) => ({
        at: i.createdAt,
        storeId: String(i.storeId),
        storeName: storeName.get(String(i.storeId)) ?? 'Store',
        label: describeStoreWrite(String(i.metadata?.method ?? ''), String(i.metadata?.path ?? '')),
      })),
      total,
      page: p,
      limit: TIMELINE_PAGE,
    };
  }

  private blankRow(adminId: string, admin: any): TeamRow {
    return {
      adminId, name: admin?.name ?? null, email: admin?.email ?? null,
      stores: { assigned: 0, managed: 0 }, products: { created: 0, edited: 0 },
      replies: { sent: 0, answered: 0, medianMinutes: null, within24hPct: null },
      orders: { actioned: 0, confirmed: 0, shipped: 0, delivered: 0, courierBooked: 0, cancelled: 0, onTimePct: null, onTimeSample: 0 },
      workload: { toShip: 0, overdue: 0, waiting: 0, waitingOver24h: 0, stuck: 0, listingIssues: 0 },
      lastActiveAt: null, breaches: [],
    };
  }
}
