/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { clampInt, searchTerm } from '../common/query-safety.util';
import { maskEmail } from '../store/store-customers.util';

export const ROSTER_MAX_LIMIT = 50;
export const ROSTER_DEFAULT_LIMIT = 25;
export const ROSTER_EXPORT_CAP = 5000;
/** Safety cap on (buyer, product) groups read into memory for sorting/filtering by progress. */
export const ROSTER_GROUP_CAP = 20000;

export const ROSTER_SORTS = ['enrolled', 'progress', 'activity', 'name'] as const;
export const ROSTER_ORDERS = ['asc', 'desc'] as const;
export const ROSTER_STATUSES = ['all', 'not_started', 'in_progress', 'completed', 'inactive14'] as const;
export type RosterSort = (typeof ROSTER_SORTS)[number];
export type RosterOrder = (typeof ROSTER_ORDERS)[number];
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

export interface RosterQuery {
  page: number; limit: number; productId?: string; q?: string;
  sort: RosterSort; order: RosterOrder; status: RosterStatus;
}

function whitelist<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) throw new BadRequestException(`${label} is not valid`);
  return raw as T;
}

/** Validates untrusted query values (arrays/objects are dropped, a bad product id / sort / order / status is a 400). */
export function parseRosterQuery(raw: Record<string, unknown> = {}): RosterQuery {
  const productRaw = typeof raw.productId === 'string' ? raw.productId.trim() : '';
  if (productRaw && !isValidObjectId(productRaw)) throw new BadRequestException('productId is not valid');
  return {
    page: clampInt(raw.page, 1, 1, 100000),
    limit: clampInt(raw.limit, ROSTER_DEFAULT_LIMIT, 1, ROSTER_MAX_LIMIT),
    productId: productRaw || undefined,
    q: searchTerm(raw.q),
    sort: whitelist(raw.sort, ROSTER_SORTS, 'enrolled', 'sort'),
    order: whitelist(raw.order, ROSTER_ORDERS, 'desc', 'order'),
    status: whitelist(raw.status, ROSTER_STATUSES, 'all', 'status'),
  };
}

export interface RosterRow {
  userId: string;
  name: string;
  email: string | null; // always masked
  productId: string;
  productName: string;
  kind: 'course' | 'file';
  enrolledAt: Date | string;
  isFree: boolean;
  percent: number | null;
  completedLessons: number | null;
  totalLessons: number | null;
  downloads: number | null;
  lastActivityAt: Date | string | null;
  accessEnded: boolean;
  completed?: boolean; // certificate / completedAt present
  status?: 'not_started' | 'in_progress' | 'completed';
  inactive14?: boolean;
}

const DAY = 86400000;

/**
 * ONE status rule. Course: 0% not started, 1-99% in progress, 100% (or completedAt/certificate) completed;
 * inactive14 = in progress AND last activity more than 14 days ago (overlaps in-progress).
 * File: downloads > 0 = completed, else not started; never in progress / inactive.
 */
export function rosterStatus(r: Pick<RosterRow, 'kind' | 'percent' | 'downloads' | 'lastActivityAt' | 'completed'>, now = Date.now()) {
  if (r.kind === 'file') return { status: ((r.downloads ?? 0) > 0 ? 'completed' : 'not_started') as RosterRow['status'], inactive14: false };
  const pct = r.percent ?? 0;
  if (pct >= 100 || r.completed) return { status: 'completed' as const, inactive14: false };
  if (pct <= 0) return { status: 'not_started' as const, inactive14: false };
  const last = r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : 0;
  return { status: 'in_progress' as const, inactive14: !last || now - last > 14 * DAY };
}

export function maskRosterEmail(email: unknown): string | null {
  const m = maskEmail(email);
  return m || null;
}

const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** Sorting: nulls (files for progress, no activity) go last in BOTH directions; stable tiebreak userId, productId. */
export function compareRoster(sort: RosterSort, order: RosterOrder) {
  const dir = order === 'asc' ? 1 : -1;
  const key = (r: RosterRow): number | string | null =>
    sort === 'enrolled' ? t(r.enrolledAt)
      : sort === 'progress' ? (r.kind === 'course' ? (r.percent ?? 0) : null)
        : sort === 'activity' ? t(r.lastActivityAt)
          : (r.name || '').toLowerCase();
  return (a: RosterRow, b: RosterRow) => {
    const ka = key(a); const kb = key(b);
    if (ka === null && kb !== null) return 1;
    if (kb === null && ka !== null) return -1;
    if (ka !== null && kb !== null && ka !== kb) return (ka < kb ? -1 : 1) * dir;
    if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  };
}

export interface RosterStats { totalStudents: number; avgCompletionPct: number | null; active7d: number }
export interface RosterStatusCounts { all: number; notStarted: number; inProgress: number; completed: number; inactive14: number }

export function rosterStatusCounts(rows: RosterRow[]): RosterStatusCounts {
  const c: RosterStatusCounts = { all: rows.length, notStarted: 0, inProgress: 0, completed: 0, inactive14: 0 };
  for (const r of rows) {
    if (r.status === 'not_started') c.notStarted++;
    else if (r.status === 'in_progress') c.inProgress++;
    else if (r.status === 'completed') c.completed++;
    if (r.inactive14) c.inactive14++;
  }
  return c;
}

/** Cards: distinct buyers, mean % over COURSE rows, buyers with course activity in the last 7 days. */
export function rosterStats(rows: RosterRow[], now = Date.now()): RosterStats {
  const buyers = new Set<string>();
  const active = new Set<string>();
  let sum = 0; let n = 0;
  for (const r of rows) {
    buyers.add(r.userId);
    if (r.kind !== 'course') continue;
    sum += r.percent ?? 0; n++;
    const last = t(r.lastActivityAt);
    if (last !== null && now - last <= 7 * DAY) active.add(r.userId);
  }
  return { totalStudents: buyers.size, avgCompletionPct: n ? Math.round(sum / n) : null, active7d: active.size };
}

export function matchesStatus(r: RosterRow, status: RosterStatus) {
  if (status === 'all') return true;
  if (status === 'inactive14') return !!r.inactive14;
  return r.status === status;
}

/**
 * Pure view builder. `rows` = every (buyer, product) row already narrowed by q + product.
 * Stats honour product only (`statsRows`), chips honour q + product (`rows`), the table also honours status.
 */
export function buildRosterView(rows: RosterRow[], statsRows: RosterRow[], query: Pick<RosterQuery, 'sort' | 'order' | 'status' | 'page' | 'limit'>, now = Date.now()) {
  const stamp = (r: RosterRow) => Object.assign(r, rosterStatus(r, now));
  rows.forEach(stamp); statsRows.forEach(stamp);
  const filtered = rows.filter(r => matchesStatus(r, query.status)).sort(compareRoster(query.sort, query.order));
  return {
    total: filtered.length,
    sorted: filtered,
    pageRows: filtered.slice((query.page - 1) * query.limit, query.page * query.limit),
    statusCounts: rosterStatusCounts(rows),
    stats: rosterStats(statsRows, now),
  };
}

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const STATUS_LABEL: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };

/** CSV header + rows for the export (cells are formula-defused later by csvCell). Emails are already masked. */
export const ROSTER_CSV_HEADER = ['Student', 'Email', 'Product', 'Type', 'Enrolled', 'Free', 'Progress %', 'Lessons done', 'Downloads', 'Last activity', 'Status', 'Access'];

export function rosterCsvRows(rows: RosterRow[]): unknown[][] {
  return rows.map(r => [
    r.name, r.email ?? '', r.productName, r.kind === 'course' ? 'Course' : 'File', day(r.enrolledAt), r.isFree ? 'Free' : 'Paid',
    r.percent ?? '', r.kind === 'course' ? `${r.completedLessons ?? 0}/${r.totalLessons ?? 0}` : '', r.downloads ?? '',
    day(r.lastActivityAt), r.status ? (STATUS_LABEL[r.status] ?? '') : '', r.accessEnded ? 'Access ended' : 'Active',
  ]);
}
