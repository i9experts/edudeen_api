/* eslint-disable prettier/prettier */
import { DEBIT_NORMAL, FISCAL_YEAR_START_MONTH, type AccountType, type PartyType } from './accounting.constants';

/** Round half-up to 2 decimals (paisa), immune to binary artefacts like 1.005 -> 1.00. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;
}

/** Working in integer paisa avoids drift when summing many lines. */
export const toPaisa = (n: number) => Math.round(round2(n) * 100);

/** 'YYYY-MM' of a date (UTC). */
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Fiscal year label 'YYYY-YY' (July..June): 2026-08-10 -> '2026-27', 2027-03-01 -> '2026-27'. */
export function fiscalYearOf(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() + 1 >= FISCAL_YEAR_START_MONTH ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** First day (UTC midnight) of the fiscal year containing d. */
export function fiscalYearStart(d: Date): Date {
  const start = Number(fiscalYearOf(d).slice(0, 4));
  return new Date(Date.UTC(start, FISCAL_YEAR_START_MONTH - 1, 1));
}

/** Parse 'YYYY-MM-DD' (or ISO) to a UTC date; null when invalid. */
export function parseDay(s: unknown): Date | null {
  if (typeof s !== 'string' || !s.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** End of a UTC day (inclusive upper bound for "as of" / "to" filters). */
export const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));

export interface LineInput {
  accountCode: string;
  debit?: number;
  credit?: number;
  currency?: string;
  amountOriginal?: number | null;
  fxRate?: number | null;
  party?: { type: PartyType; id: string; name?: string | null } | null;
  storeId?: string | null;
  description?: string | null;
}

export interface CleanLine {
  accountCode: string;
  debit: number;
  credit: number;
  currency: string;
  amountOriginal: number | null;
  fxRate: number | null;
  party: { type: PartyType; id: string; name: string | null } | null;
  storeId: string | null;
  description: string | null;
}

/**
 * Validates and normalises journal lines: each line is a debit OR a credit (positive, 2 dp), at least two lines,
 * and total debits equal total credits to the paisa. Throws Error with a readable message otherwise.
 */
export function normaliseLines(lines: LineInput[], baseCurrency = 'PKR'): CleanLine[] {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal needs at least two lines.');
  const out: CleanLine[] = [];
  let dr = 0;
  let cr = 0;
  lines.forEach((l, i) => {
    const debit = round2(Number(l.debit ?? 0));
    const credit = round2(Number(l.credit ?? 0));
    if (!l.accountCode || typeof l.accountCode !== 'string') throw new Error(`Line ${i + 1}: choose an account.`);
    if (debit < 0 || credit < 0) throw new Error(`Line ${i + 1}: amounts cannot be negative.`);
    if ((debit > 0) === (credit > 0)) throw new Error(`Line ${i + 1}: enter either a debit or a credit.`);
    dr += toPaisa(debit);
    cr += toPaisa(credit);
    out.push({
      accountCode: l.accountCode,
      debit,
      credit,
      currency: (l.currency || baseCurrency).toUpperCase(),
      amountOriginal: l.amountOriginal == null ? null : round2(Number(l.amountOriginal)),
      fxRate: l.fxRate == null ? null : Number(l.fxRate),
      party: l.party && l.party.id ? { type: l.party.type, id: String(l.party.id), name: l.party.name ?? null } : null,
      storeId: l.storeId ? String(l.storeId) : null,
      description: l.description ? String(l.description).slice(0, 300) : null,
    });
  });
  if (dr !== cr) throw new Error(`Debits (${(dr / 100).toFixed(2)}) and credits (${(cr / 100).toFixed(2)}) must be equal.`);
  return out;
}

/** Signed balance in the account's natural direction (positive = normal). */
export function naturalBalance(type: AccountType, debit: number, credit: number): number {
  return round2(DEBIT_NORMAL[type] ? debit - credit : credit - debit);
}

// ── FX ──────────────────────────────────────────────────────────────────────
/** Rates are "units per 1 USD" (the exchange-rate module's pivot). */
export function convertToBase(amount: number, currency: string, ratePerUsd: Record<string, number>, base = 'PKR'): { amount: number; fxRate: number } {
  const cur = currency.toUpperCase();
  if (cur === base) return { amount: round2(amount), fxRate: 1 };
  const from = cur === 'USD' ? 1 : ratePerUsd[cur];
  const to = base === 'USD' ? 1 : ratePerUsd[base];
  if (!from || !to) throw new Error(`No ${cur}/${base} exchange rate available.`);
  const fxRate = to / from; // base units per 1 unit of `currency`
  return { amount: round2(amount * fxRate), fxRate };
}

// ── Depreciation ────────────────────────────────────────────────────────────
export interface AssetForDep { cost: number; salvage: number; usefulLifeMonths: number; purchaseDate: Date }

/** Straight-line monthly charge; the last month absorbs rounding so the total equals cost - salvage exactly. */
export function monthlyDepreciation(a: AssetForDep, monthIndex: number): number {
  const base = round2(a.cost - a.salvage);
  if (base <= 0 || a.usefulLifeMonths <= 0 || monthIndex < 0 || monthIndex >= a.usefulLifeMonths) return 0;
  const per = round2(base / a.usefulLifeMonths);
  if (monthIndex === a.usefulLifeMonths - 1) return round2(base - per * (a.usefulLifeMonths - 1));
  return per;
}

/** Months between the purchase month and `period` ('YYYY-MM'); depreciation starts the month after purchase. */
export function depreciationMonthIndex(purchaseDate: Date, period: string): number {
  const [y, m] = period.split('-').map(Number);
  return (y - purchaseDate.getUTCFullYear()) * 12 + (m - 1 - purchaseDate.getUTCMonth()) - 1;
}

/** Periods ('YYYY-MM') from `from` to `to` inclusive. */
export function periodsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Last day of a period, UTC midnight. */
export function periodEnd(period: string): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
}

// ── Aging (FIFO) ────────────────────────────────────────────────────────────
export interface AgingMove { date: Date; increase: number; decrease: number }
export const AGING_BUCKETS = ['current', 'd31_60', 'd61_90', 'over90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/**
 * Ages an open balance FIFO: decreases settle the oldest increases first, whatever is left is bucketed by the
 * age of the increase it came from (0-30, 31-60, 61-90, >90 days at `asOf`). Negative open balances (an
 * overpayment) land in 'current'.
 */
export function ageBalance(moves: AgingMove[], asOf: Date): Record<AgingBucket, number> & { total: number } {
  const sorted = [...moves].sort((a, b) => a.date.getTime() - b.date.getTime());
  const open: { date: Date; amt: number }[] = [];
  let credit = 0;
  for (const mv of sorted) {
    if (mv.increase > 0) open.push({ date: mv.date, amt: toPaisa(mv.increase) });
    credit += toPaisa(mv.decrease);
    while (credit > 0 && open.length) {
      const take = Math.min(credit, open[0].amt);
      open[0].amt -= take;
      credit -= take;
      if (open[0].amt === 0) open.shift();
    }
  }
  const out = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const o of open) {
    const days = Math.floor((asOf.getTime() - o.date.getTime()) / 86_400_000);
    const k: AgingBucket = days <= 30 ? 'current' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'over90';
    out[k] += o.amt;
  }
  out.current -= credit; // unapplied payment
  for (const k of [...AGING_BUCKETS]) out[k] = out[k] / 100;
  out.total = round2(out.current + out.d31_60 + out.d61_90 + out.over90);
  return out;
}

// ── Statements ──────────────────────────────────────────────────────────────
export interface AccountRow { code: string; name: string; type: AccountType; subtype: string; debit: number; credit: number }

export function trialBalance(rows: AccountRow[]) {
  const items = rows
    .map((r) => {
      const net = round2(r.debit - r.credit);
      return { code: r.code, name: r.name, type: r.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const totalDebit = round2(items.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(items.reduce((s, r) => s + r.credit, 0));
  return { items, totalDebit, totalCredit, balanced: toPaisa(totalDebit) === toPaisa(totalCredit) };
}

export function profitAndLoss(rows: AccountRow[]) {
  const line = (r: AccountRow) => ({ code: r.code, name: r.name, subtype: r.subtype, amount: naturalBalance(r.type, r.debit, r.credit) });
  const income = rows.filter((r) => r.type === 'income').map(line).filter((l) => l.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const expenses = rows.filter((r) => r.type === 'expense').map(line).filter((l) => l.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const totalIncome = round2(income.reduce((s, l) => s + l.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, l) => s + l.amount, 0));
  return { income, expenses, totalIncome, totalExpenses, netProfit: round2(totalIncome - totalExpenses) };
}

/**
 * Balance sheet as of a date. Year-end close is done at report time (no closing entries): every income/expense
 * movement before the current fiscal year is shown as retained earnings, the current fiscal year's as
 * "Current year earnings". `priorPL` and `currentPL` are net profit for those two windows.
 */
export function balanceSheet(rows: AccountRow[], priorPL: number, currentPL: number, labels = { retained: 'Retained earnings', current: 'Current year earnings' }) {
  const line = (r: AccountRow) => ({ code: r.code, name: r.name, subtype: r.subtype, amount: naturalBalance(r.type, r.debit, r.credit) });
  const pick = (t: AccountType) => rows.filter((r) => r.type === t).map(line).filter((l) => l.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity').filter((l) => l.subtype !== 'retained_earnings' && l.subtype !== 'current_earnings');
  const retainedPosted = rows.filter((r) => r.type === 'equity' && r.subtype === 'retained_earnings').reduce((s, r) => s + naturalBalance(r.type, r.debit, r.credit), 0);
  const retained = round2(retainedPosted + priorPL);
  if (retained !== 0) equity.push({ code: '3100', name: labels.retained, subtype: 'retained_earnings', amount: retained });
  if (round2(currentPL) !== 0) equity.push({ code: '3200', name: labels.current, subtype: 'current_earnings', amount: round2(currentPL) });
  const totalAssets = round2(assets.reduce((s, l) => s + l.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, l) => s + l.amount, 0));
  const totalEquity = round2(equity.reduce((s, l) => s + l.amount, 0));
  return {
    assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity,
    balanced: toPaisa(totalAssets) === toPaisa(round2(totalLiabilities + totalEquity)),
  };
}
