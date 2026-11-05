/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { clampInt, searchTerm } from '../common/query-safety.util';

export const ROSTER_MAX_LIMIT = 50;
export const ROSTER_EXPORT_CAP = 5000;

export interface RosterQuery { page: number; limit: number; productId?: string; q?: string }

/** Validates untrusted query values (arrays/objects are dropped, a bad product id is a 400). */
export function parseRosterQuery(raw: Record<string, unknown> = {}): RosterQuery {
  const productRaw = typeof raw.productId === 'string' ? raw.productId.trim() : '';
  if (productRaw && !isValidObjectId(productRaw)) throw new BadRequestException('productId is not valid');
  return {
    page: clampInt(raw.page, 1, 1, 100000),
    limit: clampInt(raw.limit, 20, 1, ROSTER_MAX_LIMIT),
    productId: productRaw || undefined,
    q: searchTerm(raw.q),
  };
}

export interface RosterRow {
  userId: string;
  name: string;
  email: string | null;
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
}

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** CSV header + rows for the export (cells are formula-defused later by csvCell). */
export const ROSTER_CSV_HEADER = ['Student', 'Email', 'Product', 'Type', 'Enrolled', 'Free', 'Progress %', 'Lessons done', 'Downloads', 'Last activity', 'Access'];

export function rosterCsvRows(rows: RosterRow[]): unknown[][] {
  return rows.map(r => [
    r.name, r.email ?? '', r.productName, r.kind === 'course' ? 'Course' : 'File', day(r.enrolledAt), r.isFree ? 'Free' : 'Paid',
    r.percent ?? '', r.kind === 'course' ? `${r.completedLessons ?? 0}/${r.totalLessons ?? 0}` : '', r.downloads ?? '',
    day(r.lastActivityAt), r.accessEnded ? 'Access ended' : 'Active',
  ]);
}
