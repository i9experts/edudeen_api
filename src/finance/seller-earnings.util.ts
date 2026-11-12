/* eslint-disable prettier/prettier */
import { csvCell, csvLine } from 'src/common/query-safety.util';
import { round } from 'src/common/number.util';

/**
 * Pure helpers for the seller Earnings page (read-only). Nothing here writes to
 * the ledger: it only re-reads transaction rows that FinanceService already wrote.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface PayoutScheduleLike {
  frequency?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
}

/** Next scheduled payout moment strictly after `from` (09:00 local), or null for a manual schedule. */
export function nextPayoutDate(schedule: PayoutScheduleLike | null | undefined, from: Date = new Date()): Date | null {
  const freq = schedule?.frequency ?? 'monthly';
  const next = new Date(from);
  if (freq === 'weekly') {
    const target = schedule?.dayOfWeek ?? 1;
    const diff = (target + 7 - from.getDay()) % 7 || 7;
    next.setDate(from.getDate() + diff);
  } else if (freq === 'biweekly') {
    next.setDate(from.getDate() + 14);
  } else if (freq === 'monthly') {
    // (year, month, day) constructor: a late-month "from" can never overflow into skipping a month.
    const day = Math.min(Math.max(schedule?.dayOfMonth ?? 1, 1), 28);
    const thisMonth = new Date(from.getFullYear(), from.getMonth(), day, 9, 0, 0, 0);
    return thisMonth > from ? thisMonth : new Date(from.getFullYear(), from.getMonth() + 1, day, 9, 0, 0, 0);
  } else if (freq === 'daily') {
    next.setDate(from.getDate() + 1);
  } else {
    return null;
  }
  next.setHours(9, 0, 0, 0);
  return next;
}

/**
 * The ONE next-payout rule for every view (overview + each month): nothing payable -> null;
 * otherwise the next schedule date, pushed to the first date on/after `notBefore` (the moment the
 * earliest clearing amount is released) when no money is available yet.
 */
export function resolveNextPayout(
  schedule: PayoutScheduleLike | null | undefined,
  payable: number,
  now: Date = new Date(),
  notBefore: Date | null = null,
): Date | null {
  if (!(payable > 0)) return null;
  let next = nextPayoutDate(schedule, now);
  for (let i = 0; next && notBefore && next < notBefore && i < 60; i++) next = nextPayoutDate(schedule, next);
  return next;
}

/** Earliest moment a still-clearing sale becomes available: createdAt + its own clearingDays. */
export function earliestRelease(rows: Array<{ createdAt: Date | string; metadata?: { clearingDays?: number } | null }>, defaultDays = 3): Date | null {
  let min: number | null = null;
  for (const r of rows) {
    const at = new Date(r.createdAt).getTime() + (r.metadata?.clearingDays ?? defaultDays) * DAY_MS;
    if (Number.isFinite(at) && (min === null || at < min)) min = at;
  }
  return min === null ? null : new Date(min);
}

// ── Statement lines (one per order) ──────────────────────────────────────────

export interface LedgerTx {
  _id?: any;
  type: string;
  amount: number;
  status?: string;
  referenceId?: string | null;
  referenceType?: string | null;
  description?: string;
  createdAt: Date | string;
  metadata?: Record<string, any> | null;
}

export type LineStatus = 'clearing' | 'available' | 'paid_out' | 'cod_debit' | 'refunded';

export interface StatementLine {
  orderId: string | null;
  date: string;
  /** 'sale' (platform collected) | 'cod' (seller collected the cash; only the commission is debited) | 'other' */
  kind: 'sale' | 'cod' | 'other';
  gross: number;
  platformFee: number;
  processingFee: number;
  refund: number;
  net: number;
  status: LineStatus;
  clearingUntil: string | null;
}

export interface StatementTotals {
  orderCount: number;
  gross: number;
  platformFee: number;
  processingFee: number;
  refunds: number;
  net: number;
}

/**
 * Same net rule as FinanceService.summarizeMonthlyLedger (sales minus cash sales, minus fee rows, minus
 * wallet refunds, plus reversed COD commission and credited platform subsidies), but split per order so the
 * rows add up to the month. Failed rows are ignored there too.
 */
export function buildStatementLines(txs: LedgerTx[], opts: { monthPayoutCompleted?: boolean } = {}): { lines: StatementLine[]; totals: StatementTotals } {
  const groups = new Map<string, LedgerTx[]>();
  for (const t of txs) {
    if (t.status === 'failed') continue;
    const key = t.referenceId ? String(t.referenceId) : `misc:${String(t._id ?? '')}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }

  const isCash = (t: LedgerTx) => t.metadata?.collectedBy === 'seller' || t.metadata?.codCommission === true;
  const lines: StatementLine[] = [];
  for (const [key, rows] of groups) {
    let gross = 0, cashGross = 0, commission = 0, processing = 0, refunds = 0, cashRefunds = 0, reversed = 0, subsidy = 0;
    let saleRow: LedgerTx | null = null;
    let hasCodFee = false;
    let first = rows[0];
    for (const t of rows) {
      if (new Date(t.createdAt) < new Date(first.createdAt)) first = t;
      if (t.type === 'sale') {
        gross += t.amount;
        if (t.metadata?.collectedBy === 'seller') cashGross += t.amount;
        if (!saleRow) saleRow = t;
      } else if (t.type === 'fee') {
        commission += t.metadata?.platformFee ?? Math.abs(t.amount);
        processing += t.metadata?.processingFee ?? 0;
        if (isCash(t)) hasCodFee = true;
      } else if (t.type === 'refund') {
        refunds += Math.abs(t.amount);
        if (t.metadata?.collectedBy === 'seller') cashRefunds += Math.abs(t.amount);
      } else if (t.type === 'adjustment' && t.metadata?.codCommissionReversal === true) {
        reversed += t.amount;
      } else if (t.type === 'platform_subsidy' && t.metadata?.creditedToWallet === true) {
        subsidy += t.amount;
      }
    }
    const net = (gross - cashGross) - commission - processing - (refunds - cashRefunds) + reversed + subsidy;
    // Rows that only carry informational entries (shipping, uncredited subsidy) move no money: skip them.
    if (!gross && !commission && !processing && !refunds && !reversed && !subsidy) continue;

    const kind: StatementLine['kind'] = saleRow ? 'sale' : hasCodFee ? 'cod' : 'other';
    let status: LineStatus;
    let clearingUntil: string | null = null;
    if (kind === 'cod') status = 'cod_debit';
    else if (saleRow && saleRow.status === 'pending') {
      status = 'clearing';
      clearingUntil = new Date(new Date(saleRow.createdAt).getTime() + (saleRow.metadata?.clearingDays ?? 3) * DAY_MS).toISOString();
    } else if (refunds > 0 && refunds >= gross && gross > 0) status = 'refunded';
    else status = opts.monthPayoutCompleted ? 'paid_out' : 'available';

    lines.push({
      orderId: key.startsWith('misc:') ? null : key,
      date: new Date(first.createdAt).toISOString(),
      kind,
      gross: round(gross),
      platformFee: round(commission),
      processingFee: round(processing),
      refund: round(refunds),
      net: round(net),
      status,
      clearingUntil,
    });
  }
  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Totals are the sum of the (already rounded) rows so the table always adds up to its own total.
  const sum = (f: (l: StatementLine) => number) => round(lines.reduce((s, l) => s + f(l), 0));
  const totals: StatementTotals = {
    orderCount: lines.filter((l) => l.orderId).length,
    gross: sum((l) => l.gross),
    platformFee: sum((l) => l.platformFee),
    processingFee: sum((l) => l.processingFee),
    refunds: sum((l) => l.refund),
    net: sum((l) => l.net),
  };
  return { lines, totals };
}

const STATUS_TEXT: Record<LineStatus, string> = {
  clearing: 'Clearing', available: 'Available', paid_out: 'Paid out', cod_debit: 'COD commission', refunded: 'Refunded',
};
export const lineStatusText = (l: StatementLine) =>
  l.status === 'clearing' && l.clearingUntil ? `Clearing until ${l.clearingUntil.slice(0, 10)}` : STATUS_TEXT[l.status];

/** Statement CSV: formula-safe cells, a TRUNCATED line when the row cap cut the month short, then the totals the screen shows. */
export function statementCsv(
  meta: { month: string; currency: string; orderNumbers: Map<string, string> },
  lines: StatementLine[],
  totals: StatementTotals,
  truncated: boolean,
): string {
  const head = csvLine(['Date', 'Order', 'Type', 'Gross', 'Platform fee', 'Processing fee', 'Refund', 'Net', 'Status']);
  // Numbers are built from numeric values only, so a leading "-" is data, not a formula: quoted as-is.
  const num = (n: number) => `"${meta.currency === 'PKR' ? n.toFixed(0) : n.toFixed(2)}"`;
  const rows = lines.map((l) => [
    csvCell(l.date.slice(0, 10)),
    csvCell(l.orderId ? (meta.orderNumbers.get(l.orderId) ?? l.orderId) : ''),
    csvCell(l.kind === 'cod' ? 'COD (cash collected by you)' : l.kind === 'sale' ? 'Sale' : 'Other'),
    num(l.gross), num(l.platformFee), num(l.processingFee), num(l.refund), num(l.net),
    csvCell(lineStatusText(l)),
  ].join(','));
  const out = [csvLine([`Statement ${meta.month}`, meta.currency]), head, ...rows,
    [csvCell('TOTAL'), '""', '""', num(totals.gross), num(totals.platformFee), num(totals.processingFee), num(totals.refunds), num(totals.net), '""'].join(',')];
  if (truncated) out.push(csvLine(['TRUNCATED: this month has more rows than the export cap - the totals above cover only the rows listed']));
  return out.join('\n');
}
