import { BadRequestException } from '@nestjs/common';

/**
 * Neutralises CSV/spreadsheet formula injection: a cell that STARTS with = + - @ (or a tab/CR, which some apps
 * strip before evaluating) is executed as a formula when the file is opened in Excel/Sheets/Numbers. Prefixing a
 * single quote makes it plain text. Applied before the normal CSV quoting.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Escapes regex metacharacters so user input is matched literally (ReDoS / pattern injection). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A user-supplied search term: a bounded string, or undefined. Objects/arrays (?q[$ne]=x) are dropped. */
export function searchTerm(value: unknown, maxLength = 100): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? t.slice(0, maxLength) : undefined;
}

/** A plain string filter value (never an operator object). */
export function plainString(value: unknown, maxLength = 100): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

/** Parses a date query param; an invalid one is a 400 instead of a CastError 500. */
export function parseDateParam(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') throw new BadRequestException(`${field} is not a valid date`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
  return d;
}
