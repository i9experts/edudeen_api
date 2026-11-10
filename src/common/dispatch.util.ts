/**
 * Dispatch (handling) time: the number of WORKING days a seller has to mark a physical package shipped.
 * Sundays are not counted (Asia/Karachi, UTC+5, no DST). The due moment keeps the time of day of the
 * payment moment (paidAt, COD: order creation).
 *
 * ONE definition, used everywhere: Orders list "Ship by", dashboard to-ship / overdue counts, list sort,
 * the dispatch-on-time rate (Store Health + public trust). Mongo cannot loop, so `dispatchDueExpr` is the
 * exact closed form of `addWorkingDays`; the spec proves both agree for every weekday and N = 1..7.
 *
 * Legacy packages (no `dispatchDays` snapshot) keep the old rule: payment moment + 48 hours.
 */
export const LEGACY_DISPATCH_HOURS = 48;
export const DISPATCH_DAYS_DEFAULT = 2;
export const DISPATCH_DAYS_MIN = 1;
export const DISPATCH_DAYS_MAX = 7;

const DAY_MS = 86_400_000;
const PKT_OFFSET_MS = 5 * 3_600_000;

/** Whole number 1..7 (numeric strings allowed) or null. */
export function parseDispatchDays(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= DISPATCH_DAYS_MIN && n <= DISPATCH_DAYS_MAX ? n : null;
}

/** Day of week in Pakistan: 0 = Sunday ... 6 = Saturday. */
export function pktWeekday(ms: number): number {
  return new Date(ms + PKT_OFFSET_MS).getUTCDay();
}

/** `n` working days after `date` (Sundays skipped, Pakistan time). n <= 0 returns the same moment. */
export function addWorkingDays(date: Date | string | number, n: number): Date {
  let ms = new Date(date).getTime();
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    ms += DAY_MS;
    if (pktWeekday(ms) !== 0) left--;
  }
  return new Date(ms);
}

/** Due moment of a package: snapshot working days when present, else the legacy base + 48 h. */
export function dispatchDueAt(base: Date | string | number, dispatchDays?: number | null): Date {
  const n = parseDispatchDays(dispatchDays);
  return n ? addWorkingDays(base, n) : new Date(new Date(base).getTime() + LEGACY_DISPATCH_HOURS * 3_600_000);
}

/** Package value = the largest override among its physical items, else the store value, else the default. */
export function resolvePackageDispatchDays(storeDays: unknown, itemOverrides: unknown[]): number {
  const overrides = itemOverrides.map(parseDispatchDays).filter((x): x is number => x !== null);
  if (overrides.length) return Math.max(...overrides);
  return parseDispatchDays(storeDays) ?? DISPATCH_DAYS_DEFAULT;
}

/** Calendar days added by `n` working days from a Mongo $dayOfWeek value (1 = Sunday ... 7 = Saturday). */
export function workingCalendarDays(mongoDow: number, n: number): number {
  const sunday = mongoDow === 1;
  const s = sunday ? 5 : mongoDow - 2; // Mon = 0 ... Sat = 5; a Sunday start behaves like Saturday, one day earlier
  return n + Math.floor((s + n) / 6) + (sunday ? -1 : 0);
}

/**
 * Mongo aggregation expression for a package's due moment.
 * `pkg` = variable holding the sellerOrder (e.g. '$$p' or '$_pkg'), `base` = expression for the payment moment.
 * Same result as `dispatchDueAt` for dispatchDays 1..7; a missing/invalid snapshot gives base + 48 h.
 */
export function dispatchDueExpr(pkg: string, base: any): any {
  const dow = { $dayOfWeek: { date: base, timezone: 'Asia/Karachi' } };
  const sunday = { $eq: [dow, 1] };
  const s = { $cond: [sunday, 5, { $subtract: [dow, 2] }] };
  const n = `${pkg}.dispatchDays`;
  const calDays = { $add: [n, { $floor: { $divide: [{ $add: [s, n] }, 6] } }, { $cond: [sunday, -1, 0] }] };
  return {
    $cond: [
      { $and: [{ $gte: [{ $ifNull: [n, 0] }, DISPATCH_DAYS_MIN] }, { $lte: [{ $ifNull: [n, 0] }, DISPATCH_DAYS_MAX] }] },
      { $add: [base, { $multiply: [calDays, DAY_MS] }] },
      { $add: [base, LEGACY_DISPATCH_HOURS * 3_600_000] },
    ],
  };
}
