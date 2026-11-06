/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { pktDayStart } from './order-aggregation.util';

export type RangePreset = '7d' | '30d' | '90d' | '6m' | '12m' | 'custom';
export type BucketGranularity = 'day' | 'week' | 'month';

export interface ResolvedRange {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
  granularity: BucketGranularity;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366 * 2; // 2 years

/**
 * Resolves a `range` preset (or an explicit `from`/`to` custom range) into
 * concrete UTC boundaries, the immediately-preceding period of equal length
 * (for period-over-period comparisons), and an auto-selected chart bucket
 * granularity — daily for ranges up to a month, weekly up to a quarter,
 * monthly beyond that.
 */
export const PKT_OFFSET_MS = 5 * 3600 * 1000; // Asia/Karachi, UTC+5, no DST
const PKT_MAX_RANGE_DAYS = 366; // "12 months"

/**
 * Seller analytics range in Asia/Karachi calendar days:
 * - "Last N days" = today + the previous N-1 days, ending at the END of today (stable cache keys);
 * - custom from/to = whole PKT days, `to` inclusive up to 23:59:59.999 of that day;
 * - previous period = same length, ends 1 ms before the current one starts (no overlap).
 */
function resolvePktRange(params: { range?: string; from?: string; to?: string }): ResolvedRange {
  const { range, from, to } = params;
  const todayStart = pktDayStart(new Date());
  const endToday = new Date(todayStart.getTime() + MS_PER_DAY - 1);

  let resolvedFrom: Date;
  let resolvedTo: Date;

  if (range === 'custom' || (!range && (from || to))) {
    if (!from || !to) throw new BadRequestException('Custom range requires both "from" and "to"');
    const parse = (s: string): Date => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:00`) : pktDayStart(new Date(s)));
    const f = parse(from);
    const t = parse(to);
    if (isNaN(f.getTime()) || isNaN(t.getTime())) throw new BadRequestException('Invalid "from"/"to" date');
    resolvedFrom = pktDayStart(f);
    resolvedTo = new Date(pktDayStart(t).getTime() + MS_PER_DAY - 1);
    if (resolvedFrom > resolvedTo) throw new BadRequestException('"from" must not be after "to"');
    if (resolvedTo > endToday) throw new BadRequestException('"to" cannot be in the future');
  } else {
    resolvedTo = endToday;
    switch (range ?? '30d') {
      case '7d': resolvedFrom = new Date(todayStart.getTime() - 6 * MS_PER_DAY); break;
      case '30d': resolvedFrom = new Date(todayStart.getTime() - 29 * MS_PER_DAY); break;
      case '90d': resolvedFrom = new Date(todayStart.getTime() - 89 * MS_PER_DAY); break;
      case '6m':
      case '12m': {
        const shifted = new Date(todayStart.getTime() + PKT_OFFSET_MS);
        shifted.setUTCMonth(shifted.getUTCMonth() - (range === '6m' ? 6 : 12));
        resolvedFrom = new Date(shifted.getTime() - PKT_OFFSET_MS + MS_PER_DAY);
        break;
      }
      default:
        throw new BadRequestException(`Unknown range "${range}"`);
    }
  }

  const spanMs = resolvedTo.getTime() - resolvedFrom.getTime() + 1;
  const spanDays = spanMs / MS_PER_DAY;
  if (spanDays > PKT_MAX_RANGE_DAYS) throw new BadRequestException('Range cannot exceed 12 months');

  const previousTo = new Date(resolvedFrom.getTime() - 1);
  const previousFrom = new Date(resolvedFrom.getTime() - spanMs);
  const granularity: BucketGranularity = spanDays <= 31 ? 'day' : spanDays <= 90 ? 'week' : 'month';
  return { from: resolvedFrom, to: resolvedTo, previousFrom, previousTo, granularity };
}

export function resolveDateRange(params: { range?: string; from?: string; to?: string }, opts?: { pkt?: boolean }): ResolvedRange {
  if (opts?.pkt) return resolvePktRange(params);
  const { range, from, to } = params;

  let resolvedFrom: Date;
  let resolvedTo: Date;

  if (range === 'custom' || (!range && (from || to))) {
    if (!from || !to) {
      throw new BadRequestException('Custom range requires both "from" and "to"');
    }
    resolvedFrom = new Date(from);
    resolvedTo = new Date(to);
    if (isNaN(resolvedFrom.getTime()) || isNaN(resolvedTo.getTime())) {
      throw new BadRequestException('Invalid "from"/"to" date');
    }
    if (resolvedFrom >= resolvedTo) {
      throw new BadRequestException('"from" must be before "to"');
    }
  } else {
    resolvedTo = new Date();
    resolvedFrom = new Date();
    switch (range ?? '30d') {
      case '7d':
        resolvedFrom.setDate(resolvedFrom.getDate() - 7);
        break;
      case '30d':
        resolvedFrom.setDate(resolvedFrom.getDate() - 30);
        break;
      case '90d':
        resolvedFrom.setDate(resolvedFrom.getDate() - 90);
        break;
      case '6m':
        resolvedFrom.setMonth(resolvedFrom.getMonth() - 6);
        break;
      case '12m':
        resolvedFrom.setMonth(resolvedFrom.getMonth() - 12);
        break;
      default:
        throw new BadRequestException(`Unknown range "${range}"`);
    }
  }

  const spanDays = (resolvedTo.getTime() - resolvedFrom.getTime()) / MS_PER_DAY;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestException(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  }

  const spanMs = resolvedTo.getTime() - resolvedFrom.getTime();
  const previousTo = new Date(resolvedFrom.getTime());
  const previousFrom = new Date(resolvedFrom.getTime() - spanMs);

  const granularity: BucketGranularity = spanDays <= 31 ? 'day' : spanDays <= 90 ? 'week' : 'month';

  return { from: resolvedFrom, to: resolvedTo, previousFrom, previousTo, granularity };
}

/** Percent change, current vs previous. Null (not Infinity/NaN) when previous was 0 — there's no meaningful "% change" from zero. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Absolute delta, current vs previous — matches the "+182 vs last period" style. */
export function absoluteChange(current: number, previous: number): number {
  return current - previous;
}

export type Trend = 'improving' | 'declining' | 'flat';

/** Flat within +/-0.5 percentage points — avoids noisy "improving"/"declining" flip-flops on tiny moves. */
export function trendFor(currentPercent: number, previousPercent: number): Trend {
  const delta = currentPercent - previousPercent;
  if (Math.abs(delta) < 0.5) return 'flat';
  return delta > 0 ? 'improving' : 'declining';
}

/** Every bucket boundary between from/to at the given granularity, UTC-truncated — used to zero-fill chart series so gaps don't disappear. */
export function enumerateBuckets(from: Date, to: Date, granularity: BucketGranularity, offsetMs = 0): Date[] {
  const buckets: Date[] = [];
  // Work in "shifted" time (zone wall clock read as UTC) so month/week steps are exact; shift back when pushing.
  const cursor = truncateToBucket(new Date(from.getTime() + offsetMs), granularity);
  const end = truncateToBucket(new Date(to.getTime() + offsetMs), granularity);

  while (cursor <= end) {
    buckets.push(new Date(cursor.getTime() - offsetMs));
    if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (granularity === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}

/** The bucket boundary immediately after `bucket` at the given granularity — used to test whether a timestamp falls inside a specific bucket. */
export function nextBucket(bucket: Date, granularity: BucketGranularity, offsetMs = 0): Date {
  const next = new Date(bucket.getTime() + offsetMs);
  if (granularity === 'day') next.setUTCDate(next.getUTCDate() + 1);
  else if (granularity === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return new Date(next.getTime() - offsetMs);
}

function truncateToBucket(date: Date, granularity: BucketGranularity): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (granularity === 'month') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
  if (granularity === 'week') {
    const day = d.getUTCDay();
    const diff = (day + 6) % 7; // Monday-start weeks
    d.setUTCDate(d.getUTCDate() - diff);
  }
  return d;
}
