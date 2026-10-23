/* eslint-disable prettier/prettier */
import { csvLine } from './query-safety.util';

/** Hard row cap for every admin CSV export. Fetch CAP + 1 rows so `toExportCsv` can tell whether it was cut. */
export const EXPORT_ROW_CAP = 5000;

/**
 * One CSV writer for admin exports: every cell is quoted and formula-defused (`csvCell`: =,+,-,@ get a ' prefix).
 * When more rows existed than the cap, the first line says so, so nobody mistakes a cut file for the full data.
 */
export function toExportCsv(header: string[], rows: unknown[][], opts: { cap?: number; label?: string } = {}): { csv: string; truncated: boolean; rowCount: number } {
  const cap = opts.cap ?? EXPORT_ROW_CAP;
  const truncated = rows.length > cap;
  const kept = truncated ? rows.slice(0, cap) : rows;
  const lines: string[] = [];
  if (truncated) {
    lines.push(csvLine([`TRUNCATED: only the newest ${cap} ${opts.label ?? 'rows'} are included - narrow the filters to see older rows`]));
  }
  lines.push(csvLine(header));
  for (const r of kept) lines.push(csvLine(r));
  return { csv: lines.join('\n'), truncated, rowCount: kept.length };
}
