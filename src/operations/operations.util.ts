/* eslint-disable prettier/prettier */
import { dispatchDueAt } from '../common/dispatch.util';
import { HEALTH_TARGETS } from '../store-dashboard/store-health.util';
import type { MouStatus } from '../managed-stores/managed-stores.util';

/**
 * Seller Operations Center (super admin): pure rules shared by the overview list and the store detail page.
 * Thresholds reuse the seller Store Health targets so the admin view and the seller's own page agree.
 */

/** Edudeen's home market. A store in this country is "national"; any other country is "international". */
export const HOME_COUNTRY = 'PK';
/** Unanswered buyer chats older than this count against the store (same 24 h as the response-rate rule). */
export const UNANSWERED_HOURS = 24;
/** A shipped parcel with no delivery after this many days is "stuck". Cross-border gets longer. */
export const STUCK_DAYS = { domestic: 7, cross_border: 21 } as const;

export type Region = 'national' | 'international';
export type ShipmentKind = 'domestic' | 'cross_border' | 'unknown';
export type HealthLevel = 'good' | 'watch' | 'action';

const DAY_MS = 86_400_000;

const iso2 = (c: unknown): string | null => (typeof c === 'string' && /^[A-Za-z]{2}$/.test(c.trim()) ? c.trim().toUpperCase() : null);

/** Store.country defaults to PK; a missing value is treated the same way. */
export function storeCountry(c: unknown): string {
  return iso2(c) ?? HOME_COUNTRY;
}

export function regionOf(country: unknown): Region {
  return storeCountry(country) === HOME_COUNTRY ? 'national' : 'international';
}

/** Domestic = buyer address in the store's country; unknown when the order has no buyer country (older orders). */
export function shipmentKind(storeCountryCode: unknown, buyerCountry: unknown): ShipmentKind {
  const buyer = iso2(buyerCountry);
  if (!buyer) return 'unknown';
  return buyer === storeCountry(storeCountryCode) ? 'domestic' : 'cross_border';
}

/** Shipped and not delivered for longer than the limit of its kind (unknown uses the domestic limit). */
export function isStuck(shippedAt: Date | string | null | undefined, kind: ShipmentKind, now: Date = new Date()): boolean {
  if (!shippedAt) return false;
  const limit = kind === 'cross_border' ? STUCK_DAYS.cross_border : STUCK_DAYS.domestic;
  return now.getTime() - new Date(shippedAt).getTime() > limit * DAY_MS;
}

/** One open (not yet delivered/cancelled) package, as read from an order. */
export interface OpenPackage {
  status: string;
  fulfillmentType: string | null;
  /** Order paid, package paid, or cash on delivery. */
  payable: boolean;
  /** Payment moment (paidAt; COD/unpaid: order creation). */
  baseAt: Date | string | null;
  dispatchDays: number | null;
  shippedAt: Date | string | null;
}

const PHYSICAL = new Set(['physical', 'mixed']);

/** Still to be shipped: physical, pending/processing, and the buyer has paid (or pays on delivery). */
export function isToShip(p: OpenPackage): boolean {
  return PHYSICAL.has(String(p.fulfillmentType)) && (p.status === 'pending' || p.status === 'processing') && p.payable;
}

/** To ship and past its ship-by moment (payment + the package's dispatch days; legacy 48 h). Same rule as the seller dashboard. */
export function isOverdue(p: OpenPackage, now: Date = new Date()): boolean {
  if (!isToShip(p) || !p.baseAt) return false;
  return dispatchDueAt(p.baseAt, p.dispatchDays).getTime() < now.getTime();
}

export interface HealthInput {
  overdueOrders: number;
  unansweredOver24h: number;
  stuckShipments: number;
  mouStatus: MouStatus | null;
  /** % of buyer chats answered within 24 h (null = not enough data). */
  responseRatePct: number | null;
  /** % of parcels shipped late (null = not enough data). */
  lateDispatchPct: number | null;
}

/**
 * Action needed: something is late right now (overdue parcels, buyers waiting over 24 h, stuck parcels) or the MOU
 * has ended. Watch: a trend is off target (response rate, late dispatch) or the MOU ends within 30 days.
 */
export function healthOf(h: HealthInput): { level: HealthLevel; reasons: string[] } {
  const action: string[] = [];
  const watch: string[] = [];
  if (h.overdueOrders > 0) action.push(`${h.overdueOrders} overdue order${h.overdueOrders === 1 ? '' : 's'}`);
  if (h.unansweredOver24h > 0) action.push(`${h.unansweredOver24h} buyer chat${h.unansweredOver24h === 1 ? '' : 's'} waiting over ${UNANSWERED_HOURS} h`);
  if (h.stuckShipments > 0) action.push(`${h.stuckShipments} stuck parcel${h.stuckShipments === 1 ? '' : 's'}`);
  if (h.mouStatus === 'expired') action.push('MOU has ended');
  if (h.mouStatus === 'expiring_soon') watch.push('MOU ends within 30 days');
  if (h.responseRatePct !== null && h.responseRatePct < HEALTH_TARGETS.responseRateMinPct) watch.push(`Response rate ${h.responseRatePct}% (target ${HEALTH_TARGETS.responseRateMinPct}%+)`);
  if (h.lateDispatchPct !== null && h.lateDispatchPct > HEALTH_TARGETS.lateDispatchMaxPct) watch.push(`Late dispatch ${h.lateDispatchPct}% (target ${HEALTH_TARGETS.lateDispatchMaxPct}% or less)`);
  if (action.length) return { level: 'action', reasons: [...action, ...watch] };
  if (watch.length) return { level: 'watch', reasons: watch };
  return { level: 'good', reasons: [] };
}

export const OPS_SORTS = ['attention', 'name', 'overdue', 'unanswered', 'stuck', 'toShip', 'listings'] as const;
export type OpsSort = (typeof OPS_SORTS)[number];

export const parseSort = (v: unknown): OpsSort => ((OPS_SORTS as readonly string[]).includes(String(v)) ? (v as OpsSort) : 'attention');

const LEVEL_RANK: Record<HealthLevel, number> = { action: 0, watch: 1, good: 2 };

/** Minimal row shape the sorter needs. */
export interface SortableRow {
  name: string;
  health: { level: HealthLevel };
  listings: { active: number };
  orders: { toShip: number; overdue: number };
  response: { unansweredOver24h: number };
  shipments: { stuck: number };
}

export function sortRows<T extends SortableRow>(rows: T[], sort: OpsSort): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const desc = (f: (r: T) => number) => (a: T, b: T) => f(b) - f(a) || byName(a, b);
  const cmp: Record<OpsSort, (a: T, b: T) => number> = {
    attention: (a, b) =>
      LEVEL_RANK[a.health.level] - LEVEL_RANK[b.health.level] ||
      b.orders.overdue - a.orders.overdue ||
      b.response.unansweredOver24h - a.response.unansweredOver24h ||
      b.shipments.stuck - a.shipments.stuck ||
      byName(a, b),
    name: byName,
    overdue: desc((r) => r.orders.overdue),
    unanswered: desc((r) => r.response.unansweredOver24h),
    stuck: desc((r) => r.shipments.stuck),
    toShip: desc((r) => r.orders.toShip),
    listings: desc((r) => r.listings.active),
  };
  return [...rows].sort(cmp[sort]);
}

/** Median of the stores' own medians (stores without enough data are left out). */
export function medianOf(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

/** On-time dispatch across stores, weighted by each store's sample size (null when no store has enough data). */
export function weightedPct(parts: { pct: number | null; sample: number }[]): number | null {
  let w = 0;
  let sum = 0;
  for (const p of parts) {
    if (p.pct === null || !(p.sample > 0)) continue;
    w += p.sample;
    sum += p.pct * p.sample;
  }
  return w ? Math.round(sum / w) : null;
}
