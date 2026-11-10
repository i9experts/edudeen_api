/**
 * Pure helpers for the seller's ONE returns list (item returns + item refund
 * requests merged). Read-only: the 48 h "respond by" is a DISPLAY deadline,
 * nothing is approved or rejected automatically.
 */
export const RESPOND_BY_HOURS = 48;
export const RETURN_RATE_MIN_ORDERS = 10;
const HOUR = 3_600_000;

export type ReturnsListSource = 'return' | 'refund';
export type ReturnsListStatus = 'open' | 'approved' | 'rejected';

export interface ReturnsListRow {
  source: ReturnsListSource;
  requestId: string;
  /** Item ids the action applies to (return-action takes itemIds). */
  itemIds: string[];
  orderId: string;
  orderNumber: string;
  storeId: string;
  item: string;
  buyer: string;
  type: 'Return' | 'Refund only';
  reason: string;
  status: ReturnsListStatus;
  requestedAt: Date | null;
  respondBy: Date | null;
  isOverdue: boolean;
  amount: number;
  /** Refund requests only: buyer's note + photos (shown in the review dialog). */
  note?: string | null;
  evidenceImages?: string[];
  /** Tracking-only step after approval (item_received | replacement_sent); null when none. */
  followUp?: string | null;
  /** Reason as the seller should read it (current list, legacy code, or the free text as stored). */
  reasonLabel?: string;
}

/** requested / partial_requested / pending = still waiting for the seller. */
export function normalizeStatus(raw: string | null | undefined): ReturnsListStatus {
  const s = String(raw ?? '');
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  return 'open';
}

export function respondBy(requestedAt: Date | string | null | undefined, status: ReturnsListStatus): Date | null {
  if (status !== 'open' || !requestedAt) return null;
  const t = new Date(requestedAt).getTime();
  return Number.isFinite(t) ? new Date(t + RESPOND_BY_HOURS * HOUR) : null;
}

export function isOverdue(deadline: Date | null, now: Date): boolean {
  return !!deadline && deadline.getTime() < now.getTime();
}

/** Open rows first (soonest deadline first), then everything else newest first. */
export function sortReturnsRows(rows: ReturnsListRow[]): ReturnsListRow[] {
  return [...rows].sort((a, b) => {
    const ao = a.status === 'open';
    const bo = b.status === 'open';
    if (ao !== bo) return ao ? -1 : 1;
    if (ao && bo) {
      const ad = a.respondBy?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = b.respondBy?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (ad !== bd) return ad - bd;
    }
    return (b.requestedAt?.getTime() ?? 0) - (a.requestedAt?.getTime() ?? 0);
  });
}

/** Return rate = packages with a return in the window / physical non-free packages shipped in the window. Below the minimum: pct null. */
export function buildReturnRate(returns: number, orders: number) {
  if (orders < RETURN_RATE_MIN_ORDERS) return { pct: null as number | null, returns, orders };
  return { pct: Math.min(100, Math.round((returns / orders) * 1000) / 10), returns, orders };
}

export function buildReturnsStats(rows: ReturnsListRow[], rate: { returns: number; orders: number }, refunded30d: number) {
  const open = rows.filter((r) => r.status === 'open');
  return {
    open: open.length,
    overdue: open.filter((r) => r.isOverdue).length,
    returnRate30d: buildReturnRate(rate.returns, rate.orders),
    refunded30d,
  };
}

export function filterRows(rows: ReturnsListRow[], status: string | undefined, q: string | null | undefined) {
  let out = rows;
  if (status === 'open' || status === 'approved' || status === 'rejected') out = out.filter((r) => r.status === status);
  else if (status === 'item_received' || status === 'replacement_sent') out = out.filter((r) => r.followUp === status);
  const needle = String(q ?? '').trim().toLowerCase();
  if (needle) {
    out = out.filter((r) => [r.orderNumber, r.item, r.buyer].some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }
  return out;
}
