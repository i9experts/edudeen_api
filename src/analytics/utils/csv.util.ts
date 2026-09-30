/* eslint-disable prettier/prettier */
import { csvCell } from '../../common/query-safety.util';

/**
 * Minimal CSV builder matching the hand-rolled style already used in
 * `subscriptions.service.ts#exportCsv` / `finance.service.ts` (no CSV
 * library exists in this codebase) — header row + comma-joined rows,
 * string fields quoted, numbers left bare. String cells go through `csvCell`, which defuses spreadsheet
 * formulas (=, +, -, @) — store / product / seller names in these exports are user-controlled.
 */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const header = headers.join(',') + '\n';
  const body = rows
    .map((row) =>
      row
        .map((cell) => (typeof cell === 'number' ? cell.toString() : csvCell(cell)))
        .join(','),
    )
    .join('\n');
  return header + body;
}
