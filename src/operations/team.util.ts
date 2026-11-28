/* eslint-disable prettier/prettier */
import { dispatchDueAt } from '../common/dispatch.util';
import { HEALTH_TARGETS } from '../store-dashboard/store-health.util';

/**
 * Team performance (super admin): pure rules behind the per-team-member KPIs. The data comes from the
 * attribution recorded in manage-as-seller sessions (common/acting-staff.context.ts): Message.actingStaffId,
 * Product.createdByStaffId / lastEditedByStaffId, SellerOrder.staffActions.
 */

export const TEAM_PERIODS = [7, 30, 90] as const;
export type TeamPeriod = (typeof TEAM_PERIODS)[number];
export const parsePeriod = (v: unknown): TeamPeriod => {
  const n = Number(v);
  return (TEAM_PERIODS as readonly number[]).includes(n) ? (n as TeamPeriod) : 30;
};

/** A reply slower than this counts as late (same 24 h as the store response-rate rule). */
export const REPLY_TARGET_MINUTES = 24 * 60;
/** On-time dispatch target, shared with Store Health. */
export const ON_TIME_TARGET_PCT = 100 - HEALTH_TARGETS.lateDispatchMaxPct;

const DAY_MS = 86_400_000;

export const windowStart = (days: number, now: Date = new Date()): Date => new Date(now.getTime() - days * DAY_MS);

export function inWindow(at: Date | string | null | undefined, since: Date, now: Date = new Date()): boolean {
  if (!at) return false;
  const t = new Date(at).getTime();
  return Number.isFinite(t) && t >= since.getTime() && t <= now.getTime();
}

export interface ChatMessage {
  conversationId: string;
  senderRole: string;
  actingStaffId?: string | null;
  createdAt: Date | string;
}

export interface StaffReply {
  staffId: string;
  conversationId: string;
  minutes: number;
  repliedAt: Date;
}

/**
 * First replies by team members: for every buyer message that is waiting, the FIRST store-side message after it
 * answers it. The wait is measured from the earliest unanswered buyer message (a buyer sending three messages in a
 * row is one wait). Only answers sent by a team member (actingStaffId) are returned; a reply by the seller
 * themselves still closes the wait but is not credited to anyone on the team.
 */
export function pairFirstReplies(messages: ChatMessage[]): StaffReply[] {
  const byConv = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const list = byConv.get(m.conversationId) ?? [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }
  const out: StaffReply[] = [];
  for (const [conversationId, list] of byConv) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let waitingSince: number | null = null;
    for (const m of list) {
      const t = new Date(m.createdAt).getTime();
      if (m.senderRole === 'user') {
        if (waitingSince === null) waitingSince = t;
        continue;
      }
      if (waitingSince !== null && m.actingStaffId) {
        out.push({ staffId: m.actingStaffId, conversationId, minutes: Math.max(0, Math.round((t - waitingSince) / 60_000)), repliedAt: new Date(t) });
      }
      waitingSince = null;
    }
  }
  return out;
}

/** Shipped no later than its ship-by moment (payment moment + dispatch days; legacy 48 h). */
export function shippedOnTime(baseAt: Date | string | null | undefined, dispatchDays: number | null | undefined, shippedAt: Date | string | null | undefined): boolean | null {
  if (!baseAt || !shippedAt) return null;
  return new Date(shippedAt).getTime() <= dispatchDueAt(baseAt, dispatchDays).getTime();
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

/** Package step recorded in SellerOrder.staffActions, grouped for the KPI columns. */
export type ActionKind = 'confirmed' | 'shipped' | 'delivered' | 'courier_booked' | 'cancelled' | 'other';
export function actionKind(action: string): ActionKind {
  if (action === 'status:processing' || action === 'status:confirmed') return 'confirmed';
  if (action === 'status:shipped') return 'shipped';
  if (action === 'status:delivered' || action === 'status:completed') return 'delivered';
  if (action === 'courier_booked') return 'courier_booked';
  if (action === 'cancelled' || action === 'status:cancelled') return 'cancelled';
  return 'other';
}

/** Breaches shown in red on the Team performance page. */
export function teamBreaches(r: { medianReplyMinutes: number | null; onTimeDispatchPct: number | null; openOverdue: number; openWaitingOver24h: number; openStuck: number }): string[] {
  const out: string[] = [];
  if (r.medianReplyMinutes !== null && r.medianReplyMinutes > REPLY_TARGET_MINUTES) out.push('Median reply over 24 h');
  if (r.onTimeDispatchPct !== null && r.onTimeDispatchPct < ON_TIME_TARGET_PCT) out.push(`On-time shipping under ${ON_TIME_TARGET_PCT}%`);
  if (r.openOverdue > 0) out.push(`${r.openOverdue} overdue order${r.openOverdue === 1 ? '' : 's'}`);
  if (r.openWaitingOver24h > 0) out.push(`${r.openWaitingOver24h} buyer${r.openWaitingOver24h === 1 ? '' : 's'} waiting over 24 h`);
  if (r.openStuck > 0) out.push(`${r.openStuck} stuck parcel${r.openStuck === 1 ? '' : 's'}`);
  return out;
}

/** Plain-language label for a logged manage-as-seller write (activity log `admin_act_as_write`). */
export function describeStoreWrite(method: string, path: string): string {
  const p = path.toLowerCase();
  const m = method.toUpperCase();
  if (p.includes('/messag') || p.includes('/conversation')) return 'Replied to or updated a buyer chat';
  if (p.includes('/question')) return 'Answered a product question';
  if (p.includes('/courier') || p.includes('/shipment') || p.includes('/tracking')) return 'Updated a shipment';
  if (p.includes('/return') || p.includes('/refund')) return 'Handled a return';
  if (p.includes('/order')) return m === 'DELETE' ? 'Cancelled an order' : 'Updated an order';
  if (p.includes('/variant') || p.includes('/inventory') || p.includes('/stock')) return 'Updated stock';
  if (p.includes('/product')) return m === 'POST' ? 'Added or changed a product' : m === 'DELETE' ? 'Removed a product' : 'Edited a product';
  if (p.includes('/review') || p.includes('/rating')) return 'Replied to a review';
  if (p.includes('/upload') || p.includes('/media')) return 'Uploaded a file';
  if (p.includes('/store')) return 'Changed store settings';
  return 'Made a change in the store';
}
