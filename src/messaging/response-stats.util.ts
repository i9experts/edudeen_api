/** Pure helpers for the seller "usually replies within..." statistic. */

/** Median reply time looks at the last 30 days; response rate + dispatch look at the last 90. */
export const RESPONSE_WINDOW_DAYS = 30;
export const TRUST_WINDOW_DAYS = 90;
/** One threshold for every trust number (median reply, response rate, dispatch on time). Below it: no number. */
export const TRUST_MIN_SAMPLES = 10;
export const MIN_REPLIED_CONVERSATIONS = TRUST_MIN_SAMPLES;
/** A buyer inquiry counts as "answered in time" when the seller replies within this many hours. */
export const RESPONSE_RATE_HOURS = 24;
/** A physical package counts as "dispatched on time" when it is marked shipped within this many hours of payment. */
export const DISPATCH_HOURS = 48;

export interface StatMessage { senderRole: string; at: Date | string | number }

const ts = (v: StatMessage['at']) => new Date(v).getTime();

/**
 * Minutes the seller took to answer the FIRST buyer inquiry of one conversation, or null when no buyer
 * inquiry in the given (time-ordered) messages was answered. An inquiry is a buyer message that is not
 * preceded by another buyer message since the last seller message; admin/other senders are ignored.
 */
export function firstReplyMinutes(messages: StatMessage[]): number | null {
  const sorted = messages
    .filter((m) => m.senderRole === 'user' || m.senderRole === 'seller')
    .sort((a, b) => ts(a.at) - ts(b.at));
  let inquiryAt: number | null = null;
  for (const m of sorted) {
    if (m.senderRole === 'user') {
      if (inquiryAt === null) inquiryAt = ts(m.at);
    } else if (inquiryAt !== null) {
      return Math.max(0, (ts(m.at) - inquiryAt) / 60_000);
    }
  }
  return null;
}

export interface FirstInquiry { inquiryAt: number; replyMinutes: number | null }

/** First buyer inquiry of one conversation and how long the seller took to answer it (null = not answered yet). */
export function firstInquiry(messages: StatMessage[]): FirstInquiry | null {
  const sorted = messages
    .filter((m) => m.senderRole === 'user' || m.senderRole === 'seller')
    .sort((a, b) => ts(a.at) - ts(b.at));
  let inquiryAt: number | null = null;
  for (const m of sorted) {
    if (m.senderRole === 'user') {
      if (inquiryAt === null) inquiryAt = ts(m.at);
    } else if (inquiryAt !== null) {
      return { inquiryAt, replyMinutes: Math.max(0, (ts(m.at) - inquiryAt) / 60_000) };
    }
  }
  return inquiryAt === null ? null : { inquiryAt, replyMinutes: null };
}

/**
 * Response rate = share of buyer inquiries answered within 24 h. A not-yet-answered inquiry only counts as a
 * miss once it is older than 24 h (a fresh one is still pending and is left out). Fewer than TRUST_MIN_SAMPLES
 * counted inquiries -> pct null (no invented number).
 */
export function buildResponseRate(inquiries: FirstInquiry[], now = new Date()): { pct: number | null; sample: number } {
  const limitMin = RESPONSE_RATE_HOURS * 60;
  let sample = 0;
  let hits = 0;
  for (const q of inquiries) {
    if (q.replyMinutes !== null) {
      sample++;
      if (q.replyMinutes <= limitMin) hits++;
    } else if (now.getTime() - q.inquiryAt > limitMin * 60_000) {
      sample++;
    }
  }
  return { pct: sample >= TRUST_MIN_SAMPLES ? Math.round((hits / sample) * 100) : null, sample };
}

export interface DispatchPackage {
  /** When the buyer's payment counted: order.paidAt, or order.createdAt for cash on delivery (no prepayment). null = not paid yet. */
  baseAt: Date | string | number | null;
  shippedAt: Date | string | number | null;
  cancelled: boolean;
}

const SHIPPED_LIKE = new Set(['shipped', 'delivered', 'completed']);

/**
 * One physical package row -> DispatchPackage, or null when it must be left out (shipped-like but no shipped
 * time = old data, unknown). Payment moment = paidAt, COD = order creation. Shared by the hourly trust job
 * and the seller Store Health page so both use the identical rule.
 */
export function toDispatchPackage(r: {
  status?: string | null; shippedAt?: Date | string | null; paymentType?: string | null; paidAt?: Date | string | null; createdAt?: Date | string | null;
}): DispatchPackage | null {
  const status = String(r.status ?? '');
  if (!r.shippedAt && SHIPPED_LIKE.has(status)) return null;
  return {
    baseAt: r.paymentType === 'cash_on_delivery' ? r.createdAt ?? null : r.paidAt ?? null,
    shippedAt: r.shippedAt ?? null,
    cancelled: status === 'cancelled' || status === 'refunded',
  };
}

/**
 * Dispatch on time = share of physical packages shipped within 48 h of payment. A package not shipped yet only
 * counts as late once 48 h have passed; cancelled/refunded and unpaid packages are left out. Fewer than
 * TRUST_MIN_SAMPLES counted packages -> pct null.
 */
export function buildDispatchRate(pkgs: DispatchPackage[], now = new Date()): { pct: number | null; sample: number } {
  const limitMs = DISPATCH_HOURS * 3_600_000;
  let sample = 0;
  let onTime = 0;
  for (const p of pkgs) {
    if (p.cancelled || p.baseAt == null) continue;
    const base = new Date(p.baseAt).getTime();
    if (p.shippedAt != null) {
      sample++;
      if (new Date(p.shippedAt).getTime() - base <= limitMs) onTime++;
    } else if (now.getTime() - base > limitMs) {
      sample++;
    }
  }
  return { pct: sample >= TRUST_MIN_SAMPLES ? Math.round((onTime / sample) * 100) : null, sample };
}

/** What the public store page gets: cached numbers only (pct null = "Not enough data"), plus the rules so the UI can state them. */
export function publicTrust(store: {
  trustStats?: { responseRate?: { pct: number | null; sample: number }; dispatch?: { pct: number | null; sample: number } } | null;
  shipFrom?: { city?: string | null } | null;
}) {
  const t = store.trustStats;
  const clean = (v?: { pct: number | null; sample: number }) => ({
    pct: v && v.sample >= TRUST_MIN_SAMPLES && typeof v.pct === 'number' ? v.pct : null,
    sample: v?.sample ?? 0,
  });
  return {
    responseRate: clean(t?.responseRate),
    dispatch: clean(t?.dispatch),
    city: store.shipFrom?.city?.trim() || null,
    minSamples: TRUST_MIN_SAMPLES,
    responseHours: RESPONSE_RATE_HOURS,
    dispatchHours: DISPATCH_HOURS,
  };
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One value per replied conversation -> stats, or null when there are fewer than 3 (no invented numbers). */
export function buildResponseStats(replyMinutes: number[], now = new Date()) {
  if (replyMinutes.length < MIN_REPLIED_CONVERSATIONS) return null;
  return { medianReplyMinutes: Math.round(median(replyMinutes)), sampleSize: replyMinutes.length, updatedAt: now };
}
