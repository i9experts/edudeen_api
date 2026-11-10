import { BadRequestException } from '@nestjs/common';
import { DISPATCH_DAYS_DEFAULT } from 'src/common/dispatch.util';
import {
  buildDispatchRate, buildResponseRate, median, RESPONSE_RATE_HOURS, TRUST_MIN_SAMPLES,
  type DispatchPackage, type FirstInquiry,
} from '../messaging/response-stats.util';

/**
 * Store Health (seller, read-only). Every number reuses the SAME rules and the SAME minimum sample
 * (TRUST_MIN_SAMPLES) as the public store trust strip, so the two never disagree.
 */
export type HealthRange = 30 | 90;
export type HealthStatus = 'good' | 'attention' | 'insufficient' | 'unavailable';

export interface HealthMetric {
  id: 'dispatch' | 'cancellation' | 'returns' | 'responseRate' | 'replyTime' | 'rating' | 'sentBack';
  label: string;
  /** Number to show (null = no number: insufficient or unavailable). */
  value: number | null;
  unit: 'percent' | 'minutes' | 'stars' | 'count';
  /** How many data points the number is based on. */
  sample: number;
  /** Text target, e.g. "10% or less". */
  target: string;
  status: HealthStatus;
  hint: string;
  /** ISO date the number is counted from (only metrics that began tracking late). */
  countedFrom?: string;
}

export const HEALTH_TARGETS = {
  lateDispatchMaxPct: 10,
  returnMaxPct: 10,
  sellerCancelMaxPct: 5,
  responseRateMinPct: 90,
  replyMaxMinutes: RESPONSE_RATE_HOURS * 60,
  ratingMin: 4,
} as const;

/**
 * `cancelledBy` is only written on cancels made after it was introduced; older orders carry no value, so the
 * seller-cancellation metric ignores every order created before this date (no backfill). Override with env
 * CANCELLED_BY_TRACKING_START (YYYY-MM-DD) to match the real deploy day.
 */
export function cancellationTrackingStart(): Date {
  const d = new Date(`${process.env.CANCELLED_BY_TRACKING_START || '2026-11-06'}T00:00:00+05:00`);
  return Number.isNaN(d.getTime()) ? new Date('2026-11-06T00:00:00+05:00') : d;
}

/** One physical package row for the cancellation metric. */
export interface CancellationPackage {
  /** Buyer paid (order paid) or it is cash on delivery. */
  eligible: boolean;
  status: string;
  cancelledBy: string | null;
}

export function countCancellations(pkgs: CancellationPackage[]) {
  let eligible = 0;
  let bySeller = 0;
  for (const p of pkgs) {
    if (!p.eligible) continue;
    eligible++;
    if (p.status === 'cancelled' && p.cancelledBy === 'seller') bySeller++;
  }
  return { eligible, bySeller };
}

export function parseHealthRange(raw: unknown): HealthRange {
  if (raw === undefined || raw === null || raw === '') return 30;
  const s = String(raw);
  if (s === '30') return 30;
  if (s === '90') return 90;
  throw new BadRequestException('range must be 30 or 90');
}

export interface HealthInput {
  range: HealthRange;
  now?: Date;
  /** First buyer inquiry of each conversation that had messages in the window. */
  inquiries: FirstInquiry[];
  /** Physical packages of paid-or-COD, non-free orders created in the window. */
  packages: DispatchPackage[];
  /** Physical items in delivered/completed packages, and how many of them have a return request. */
  deliveredItems: number;
  returnedItems: number;
  /** Store.averageRating / Store.reviewCount (all-time, same as the public page). */
  rating: { average: number; count: number };
  /** The store's CURRENT dispatch time (working days) - only used for the explanatory text. */
  dispatchDays?: number | null;
  /** Listings an admin sent back (status rejected) with a review inside the window. */
  sentBack: number;
  /** Eligible physical packages (created since tracking began) and how many the SELLER cancelled. */
  cancellation?: { eligible: number; bySeller: number };
}

const pctOrNull = (n: number, d: number) => (d >= TRUST_MIN_SAMPLES ? Math.round((n / d) * 100) : null);

export function buildStoreHealth(input: HealthInput) {
  const now = input.now ?? new Date();
  const { range } = input;

  // Late dispatch = 100 - dispatch-on-time (same due-date rule and same package filter as the public strip).
  const dispatch = buildDispatchRate(input.packages, now);
  const latePct = dispatch.pct === null ? null : 100 - dispatch.pct;

  const rate = buildResponseRate(input.inquiries, now);

  const replied = input.inquiries.filter((q) => q.replyMinutes !== null).map((q) => q.replyMinutes as number);
  const replyMedian = replied.length >= TRUST_MIN_SAMPLES ? Math.round(median(replied)) : null;

  const returnPct = pctOrNull(input.returnedItems, input.deliveredItems);

  const cancelPct = input.cancellation ? pctOrNull(input.cancellation.bySeller, input.cancellation.eligible) : null;

  const ratingOk =input.rating.count >= TRUST_MIN_SAMPLES;

  const st = (value: number | null, ok: boolean): HealthStatus => (value === null ? 'insufficient' : ok ? 'good' : 'attention');
  const notEnough = `Needs ${TRUST_MIN_SAMPLES} data points before a number is shown`;

  const metrics: HealthMetric[] = [
    {
      id: 'dispatch', label: 'Late dispatch', value: latePct, unit: 'percent', sample: dispatch.sample,
      target: `${HEALTH_TARGETS.lateDispatchMaxPct}% or less`,
      status: st(latePct, (latePct ?? 0) <= HEALTH_TARGETS.lateDispatchMaxPct),
      hint: latePct === null
        ? notEnough
        : `Physical parcels not marked shipped within your ${input.dispatchDays ?? DISPATCH_DAYS_DEFAULT}-day dispatch time (Sundays not counted) of payment (${dispatch.sample} parcels). Parcels placed before this setting existed use a 48-hour limit. Free claims and digital orders are not counted.`,
    },
    {
      // Seller cancels / eligible physical packages. Buyer and system cancels never count against the seller.
      id: 'cancellation', label: 'Seller cancellations', value: cancelPct, unit: 'percent', sample: input.cancellation?.eligible ?? 0,
      target: `${HEALTH_TARGETS.sellerCancelMaxPct}% or less`,
      status: input.cancellation ? st(cancelPct, (cancelPct ?? 0) <= HEALTH_TARGETS.sellerCancelMaxPct) : 'unavailable',
      hint: !input.cancellation
        ? 'Not available yet.'
        : cancelPct === null
          ? notEnough
          : `Paid or cash-on-delivery physical parcels you cancelled (${input.cancellation.eligible} parcels). Buyer and automatic cancellations are not counted.`,
      countedFrom: cancellationTrackingStart().toISOString(),
    },
    {
      id: 'returns', label: 'Return rate', value: returnPct, unit: 'percent', sample: input.deliveredItems,
      target: `${HEALTH_TARGETS.returnMaxPct}% or less`,
      status: st(returnPct, (returnPct ?? 0) <= HEALTH_TARGETS.returnMaxPct),
      hint: returnPct === null ? notEnough : `Delivered physical items with a return request (${input.deliveredItems} items).`,
    },
    {
      id: 'responseRate', label: 'Response rate', value: rate.pct, unit: 'percent', sample: rate.sample,
      target: `${HEALTH_TARGETS.responseRateMinPct}% or more`,
      status: st(rate.pct, (rate.pct ?? 0) >= HEALTH_TARGETS.responseRateMinPct),
      hint: rate.pct === null ? notEnough : `Buyer questions answered within ${RESPONSE_RATE_HOURS} hours (${rate.sample} chats).`,
    },
    {
      id: 'replyTime', label: 'First reply time', value: replyMedian, unit: 'minutes', sample: replied.length,
      target: `${RESPONSE_RATE_HOURS} hours or less`,
      status: st(replyMedian, (replyMedian ?? 0) <= HEALTH_TARGETS.replyMaxMinutes),
      hint: replyMedian === null ? notEnough : `Median time to your first reply (${replied.length} chats).`,
    },
    {
      id: 'rating', label: 'Rating', value: ratingOk ? Math.round(input.rating.average * 10) / 10 : null, unit: 'stars',
      sample: input.rating.count, target: `${HEALTH_TARGETS.ratingMin.toFixed(1)} or more`,
      status: st(ratingOk ? input.rating.average : null, input.rating.average >= HEALTH_TARGETS.ratingMin),
      hint: ratingOk
        ? `Average of all ${input.rating.count} buyer reviews (the same number buyers see; not limited to ${range} days).`
        : `${input.rating.count} review${input.rating.count === 1 ? '' : 's'} so far. ${notEnough}.`,
    },
    {
      id: 'sentBack', label: 'Listings sent back by Edudeen', value: input.sentBack, unit: 'count', sample: input.sentBack,
      target: 'None',
      status: input.sentBack === 0 ? 'good' : 'attention',
      hint: input.sentBack === 0
        ? `No listing was sent back in the last ${range} days.`
        : `Listings still marked "sent back" after a review in the last ${range} days. Open Products to see the note.`,
    },
  ];

  const evidence = (input.cancellation?.eligible ?? 0) + dispatch.sample +rate.sample + replied.length + input.deliveredItems + input.rating.count;
  // Additive: explicit sample size + minimum for each metric (sent-back is a plain count, no minimum).
  const withSamples = metrics.map((m) => ({ ...m, sampleSize: m.sample, minSample: m.id === 'sentBack' ? 0 : TRUST_MIN_SAMPLES }));
  return { range, metrics: withSamples, isNew: evidence === 0 && input.sentBack === 0, minSamples: TRUST_MIN_SAMPLES };
}
