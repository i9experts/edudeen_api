/* eslint-disable prettier/prettier */
import { round2, naturalBalance, type AccountRow } from './accounting.util';
import type { AccountType } from './accounting.constants';

/** Income accounts shown as the revenue mix, in display order. Anything else of type income is "Other". */
export const REVENUE_LINES: { key: string; label: string; codes: string[] }[] = [
  { key: 'commission_self', label: 'Commission (self-managed)', codes: ['4000'] },
  { key: 'commission_mou', label: 'Commission (managed MOU)', codes: ['4010'] },
  { key: 'processing_fees', label: 'Card processing fees', codes: ['4020'] },
  { key: 'subscriptions', label: 'Seller plan subscriptions', codes: ['4100'] },
  { key: 'addons', label: 'Add-ons', codes: ['4110'] },
  { key: 'premium', label: 'Premium memberships', codes: ['4200'] },
  { key: 'shipping', label: 'Shipping income', codes: ['4300'] },
];

/** Payroll expense accounts (salaries, allowances, incentives, employer EOBI/PF, contractor fees, claims). */
export const PAYROLL_EXPENSE_CODES = ['6000', '6010', '6020', '6030', '6040', '6050', '6060'];

/** Cash, bank and clearing accounts, plus COD still with couriers: the "money" tile and the cash trend. */
export const isCashLike = (r: { code: string; subtype: string }) => ['cash', 'bank', 'clearing'].includes(r.subtype) || r.code === '1110';

export interface RevenueMixRow { key: string; label: string; amount: number }

/** Income by revenue line (credit - debit). Lines with nothing are kept so the tiles never jump around. */
export function revenueMix(rows: AccountRow[]): { lines: RevenueMixRow[]; total: number } {
  const income = rows.filter((r) => r.type === 'income');
  const amountOf = (codes: string[]) => round2(income.filter((r) => codes.includes(r.code)).reduce((s, r) => s + (r.credit - r.debit), 0));
  const known = new Set(REVENUE_LINES.flatMap((l) => l.codes));
  const lines = REVENUE_LINES.map((l) => ({ key: l.key, label: l.label, amount: amountOf(l.codes) }));
  const other = round2(income.filter((r) => !known.has(r.code)).reduce((s, r) => s + (r.credit - r.debit), 0));
  lines.push({ key: 'other', label: 'Other income', amount: other });
  return { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/** Net debit total of the given expense accounts (payroll cost etc.). */
export function expenseTotal(rows: AccountRow[], codes: string[]): number {
  return round2(rows.filter((r) => r.type === 'expense' && codes.includes(r.code)).reduce((s, r) => s + (r.debit - r.credit), 0));
}

export interface PeriodAccountRow { period: string; code: string; type: AccountType; subtype: string; debit: number; credit: number }
export interface MonthPoint { period: string; income: number; expenses: number; net: number; cash: number }

/**
 * One point per period in `periods` (in order): income, expenses and net for that month, and the cash/bank balance
 * at its end (opening cash + every cash movement up to and including that month). Months with no entries still get
 * a point (income/expenses 0, cash carried forward).
 */
export function monthlySeries(periods: string[], rows: PeriodAccountRow[], openingCash: number): MonthPoint[] {
  const by = new Map<string, { income: number; expenses: number; cashMove: number }>();
  for (const r of rows) {
    const cur = by.get(r.period) ?? { income: 0, expenses: 0, cashMove: 0 };
    if (r.type === 'income') cur.income += r.credit - r.debit;
    else if (r.type === 'expense') cur.expenses += r.debit - r.credit;
    if (r.type === 'asset' && isCashLike(r)) cur.cashMove += naturalBalance('asset', r.debit, r.credit);
    by.set(r.period, cur);
  }
  let cash = openingCash;
  return periods.map((period) => {
    const m = by.get(period) ?? { income: 0, expenses: 0, cashMove: 0 };
    cash = round2(cash + m.cashMove);
    return { period, income: round2(m.income), expenses: round2(m.expenses), net: round2(m.income - m.expenses), cash };
  });
}

/** Fiscal-year months (July..June) from the fiscal year start up to and including `uptoPeriod`. */
export function fiscalPeriodsUpTo(fyStart: Date, uptoPeriod: string): string[] {
  const out: string[] = [];
  let y = fyStart.getUTCFullYear();
  let m = fyStart.getUTCMonth() + 1;
  for (let i = 0; i < 12; i++) {
    const p = `${y}-${String(m).padStart(2, '0')}`;
    out.push(p);
    if (p === uptoPeriod) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Order totals grouped by currency, converted to PKR with ratePerUSD (units per 1 USD). Unknown currencies are reported, not guessed. */
export function convertTotalsToPkr(byCurrency: { currency: string; total: number; count: number }[], ratePerUsd: Record<string, number>): { pkr: number; orders: number; unconverted: string[] } {
  const pkrPerUsd = ratePerUsd.PKR;
  let pkr = 0;
  let orders = 0;
  const unconverted: string[] = [];
  for (const row of byCurrency) {
    const cur = (row.currency || 'PKR').toUpperCase();
    orders += row.count;
    if (cur === 'PKR') { pkr += row.total; continue; }
    const r = cur === 'USD' ? 1 : ratePerUsd[cur];
    if (!r || !pkrPerUsd) { unconverted.push(cur); continue; }
    pkr += (row.total / r) * pkrPerUsd;
  }
  return { pkr: round2(pkr), orders, unconverted };
}

/** The finance pack's month: 'YYYY-MM' (default: the previous calendar month). */
export function packMonth(month: unknown, now = new Date()): { month: string; from: Date; to: Date } {
  let y: number;
  let m: number;
  if (typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    [y, m] = month.split('-').map(Number);
  } else {
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
  }
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { month: `${y}-${String(m).padStart(2, '0')}`, from, to };
}

/** Finance pack e-mail recipients: trimmed, lower-cased, valid, unique, at most 10. */
export function cleanRecipients(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const raw of list) {
    const e = String(raw ?? '').trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) continue;
    if (!out.includes(e)) out.push(e);
    if (out.length >= 10) break;
  }
  return out;
}
