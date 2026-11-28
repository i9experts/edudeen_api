/* eslint-disable prettier/prettier */
import { round2 } from '../accounting/accounting.util';
import {
  BONUS_METRIC_LABEL, METRIC_LABEL,
  type BonusMetric, type ClaimType, type IncentiveMetric, type RuleUnit, type WorkerType,
} from './payroll.constants';

/**
 * Pure payroll maths: proration, Pakistan salary tax (slabs + surcharge, projected-annual monthly withholding),
 * EOBI / provident fund, incentives, bonus tiers and the payslip itself. No database access here.
 */

// ── Months & tax years ────────────────────────────────────────────────────────
export const isMonth = (m: unknown): m is string => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

/** UTC bounds of a payroll month: [start, end). */
export function monthBounds(month: string): { start: Date; end: Date; days: number } {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

export const monthOf = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Tax year label for a month: July..June, e.g. '2026-08' and '2027-03' -> '2026-27'. */
export function taxYearOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function taxYearMonths(taxYear: string): string[] {
  const start = Number(taxYear.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => addMonths(`${start}-07`, i));
}

/** The person's last month on payroll in this tax year: their exit month if it falls inside it, else June. */
export function lastMonthInTaxYear(month: string, exitDate: Date | null | undefined): string {
  const june = `${Number(taxYearOf(month).slice(0, 4)) + 1}-06`;
  if (!exitDate) return june;
  const exit = monthOf(exitDate);
  return exit < june ? exit : june;
}

/** Months still to be paid in the tax year, counting the current one (>= 1). */
export function remainingMonths(month: string, exitDate: Date | null | undefined): number {
  const last = lastMonthInTaxYear(month, exitDate);
  if (last < month) return 1;
  const [y1, m1] = month.split('-').map(Number);
  const [y2, m2] = last.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

/** Calendar days the person was employed in the month (joining and exit days both count). */
export function proration(month: string, joiningDate: Date | null | undefined, exitDate: Date | null | undefined): { daysWorked: number; daysInMonth: number; factor: number } {
  const { start, end, days } = monthBounds(month);
  const day = 86_400_000;
  const from = joiningDate ? Math.max(start.getTime(), Date.UTC(joiningDate.getUTCFullYear(), joiningDate.getUTCMonth(), joiningDate.getUTCDate())) : start.getTime();
  const lastDay = end.getTime() - day;
  const to = exitDate ? Math.min(lastDay, Date.UTC(exitDate.getUTCFullYear(), exitDate.getUTCMonth(), exitDate.getUTCDate())) : lastDay;
  const worked = to < from ? 0 : Math.round((to - from) / day) + 1;
  return { daysWorked: worked, daysInMonth: days, factor: worked / days };
}

// ── Salary tax ────────────────────────────────────────────────────────────────
export interface TaxSlab { from: number; to: number | null; fixed: number; rate: number }
export interface TaxRules { slabs: TaxSlab[]; surcharge?: { threshold: number; pct: number } | null }

/**
 * Annual tax on taxable salary income: the slab containing the income gives `fixed + rate% x (income - from)`.
 * Slabs are written FBR-style: { from: 600000, to: 1200000, fixed: 0, rate: 1 } means 1% of the amount exceeding
 * 600,000. Surcharge: when income exceeds the threshold, tax x (1 + pct%).
 */
export function annualTax(income: number, rules: TaxRules): number {
  const x = Math.max(0, income);
  const slabs = [...rules.slabs].sort((a, b) => a.from - b.from);
  let tax = 0;
  for (const s of slabs) {
    if (x > s.from && (s.to === null || x <= s.to)) { tax = s.fixed + (s.rate / 100) * (x - s.from); break; }
  }
  if (rules.surcharge && rules.surcharge.pct > 0 && x > rules.surcharge.threshold) tax *= 1 + rules.surcharge.pct / 100;
  return round2(tax);
}

export interface WithholdingInput {
  /** Taxable pay that repeats every month (salary, retainer, taxable fixed allowances). */
  regular: number;
  /** Taxable one-offs this month (incentives, bonuses, taxable claims, manual additions). */
  irregular: number;
  /** Taxable income and tax already withheld earlier in this tax year (approved payroll runs). */
  ytdTaxable: number;
  ytdTax: number;
  /** Months left in the tax year including this one (exit month caps it). */
  remaining: number;
}

/**
 * Monthly withholding, projected-annual method:
 *   projected = ytdTaxable + regular x remaining
 *   base      = max(0, annualTax(projected) - ytdTax) / remaining          (spread over the months left)
 *   oneOff    = annualTax(projected + irregular) - annualTax(projected)     (all of it this month)
 *   tax       = base + oneOff
 * The last month (remaining = 1) trues the year up. A mid-year joiner simply has no earlier income.
 */
export function monthlyWithholding(i: WithholdingInput, rules: TaxRules): { tax: number; projectedAnnual: number; annualTax: number } {
  const remaining = Math.max(1, Math.floor(i.remaining));
  const projected = round2(i.ytdTaxable + Math.max(0, i.regular) * remaining);
  const taxRegular = annualTax(projected, rules);
  const taxAll = annualTax(projected + Math.max(0, i.irregular), rules);
  const base = Math.max(0, taxRegular - i.ytdTax) / remaining;
  const tax = round2(base + (taxAll - taxRegular));
  return { tax: Math.max(0, tax), projectedAnnual: round2(projected + Math.max(0, i.irregular)), annualTax: taxAll };
}

// ── Profiles (what a payroll calculation needs from a compensation profile version) ─────────
export interface Allowance { name: string; amount: number; taxable: boolean }
export interface IncentiveRule { metric: IncentiveMetric; rate: number; unit: RuleUnit; minThreshold?: number | null; cap?: number | null; label?: string | null }
export interface BonusTier { metric: BonusMetric; threshold: number; bonus: number; minSample?: number | null; label?: string | null }
export interface ClaimRate { type: ClaimType; rate: number }

export interface PayVersion {
  effectiveFrom: string;
  workerType: WorkerType;
  baseMonthlySalary: number;
  monthlyRetainer: number;
  allowances: Allowance[];
  incentiveRules: IncentiveRule[];
  bonusTiers: BonusTier[];
  claimRates: ClaimRate[];
  eobiEnabled: boolean;
  pfEnabled: boolean;
  pfEmployeePct: number;
  pfEmployerPct: number;
  /** Contractors only: % withheld from their pay (e.g. tax on services). */
  withholdingPct: number;
}

/** The version in force for a month: the latest whose effectiveFrom <= month. */
export function versionFor<T extends { effectiveFrom: string }>(versions: T[], month: string): T | null {
  return [...versions].filter((v) => v.effectiveFrom <= month).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}

// ── Incentives & bonuses ──────────────────────────────────────────────────────
export type MetricCounts = Record<IncentiveMetric, number>;
export interface PerfFigures {
  on_time_pct: number | null; on_time_sample: number;
  reply_within_24h_pct: number | null; reply_sample: number;
  orders_handled: number; products_listed: number; sellers_onboarded: number; support_replies: number;
}

export const emptyCounts = (): MetricCounts => ({
  products_listed: 0, products_edited: 0, shipments_handled: 0, orders_confirmed: 0, support_replies: 0, replies_within_24h: 0,
  sellers_onboarded: 0, managed_store_commission: 0, visits: 0,
});

/** Nothing below the threshold; at or above it every unit is paid. The cap limits the payout amount. */
export function incentiveAmount(rule: IncentiveRule, value: number): number {
  const v = Math.max(0, value || 0);
  if (rule.minThreshold && v < rule.minThreshold) return 0;
  let amount = rule.unit === 'percent' ? (rule.rate / 100) * v : rule.rate * v;
  if (rule.cap != null && rule.cap >= 0) amount = Math.min(amount, rule.cap);
  return round2(Math.max(0, amount));
}

/** Per metric, the highest tier reached pays (tiers are a ladder, not cumulative). Percent tiers need a minimum sample. */
export function bonusesFor(tiers: BonusTier[], perf: PerfFigures): { metric: BonusMetric; threshold: number; value: number; bonus: number; label: string }[] {
  const value = (m: BonusMetric): { v: number | null; sample: number } => {
    if (m === 'on_time_pct') return { v: perf.on_time_pct, sample: perf.on_time_sample };
    if (m === 'reply_within_24h_pct') return { v: perf.reply_within_24h_pct, sample: perf.reply_sample };
    return { v: perf[m], sample: Number.MAX_SAFE_INTEGER };
  };
  const best = new Map<BonusMetric, BonusTier>();
  for (const t of tiers) {
    const { v, sample } = value(t.metric);
    if (v === null || v < t.threshold) continue;
    if (t.minSample && sample < t.minSample) continue;
    const cur = best.get(t.metric);
    if (!cur || t.threshold > cur.threshold || (t.threshold === cur.threshold && t.bonus > cur.bonus)) best.set(t.metric, t);
  }
  return [...best.values()].map((t) => ({
    metric: t.metric, threshold: t.threshold, value: value(t.metric).v ?? 0, bonus: round2(Math.max(0, t.bonus)),
    label: t.label || `${BONUS_METRIC_LABEL[t.metric]} ≥ ${t.threshold}`,
  }));
}

// ── Payslip ───────────────────────────────────────────────────────────────────
export type EarningKind = 'base' | 'retainer' | 'allowance' | 'incentive' | 'bonus' | 'claim' | 'manual';
export type DeductionKind = 'income_tax' | 'eobi' | 'pf' | 'advance' | 'withholding' | 'manual';
export interface Earning { kind: EarningKind; label: string; amount: number; taxable: boolean; regular: boolean; meta?: Record<string, unknown> | null }
export interface Deduction { kind: DeductionKind; label: string; amount: number; meta?: Record<string, unknown> | null }
export interface EmployerCost { kind: 'eobi' | 'pf'; label: string; amount: number }
export interface ManualLine { type: 'addition' | 'deduction'; label: string; amount: number; taxable?: boolean }

export interface EobiRules { minimumWage: number; employeePct: number; employerPct: number }

export interface PayslipInput {
  month: string;
  version: PayVersion;
  joiningDate: Date | null;
  exitDate: Date | null;
  counts: MetricCounts;
  perf: PerfFigures;
  claims: { id: string; type: ClaimType; amount: number; taxable: boolean; label: string }[];
  advances: { id: string; outstanding: number; monthlyRecovery: number }[];
  manual: ManualLine[];
  ytd: { taxable: number; tax: number };
  tax: TaxRules;
  eobi: EobiRules;
}

export interface Payslip {
  workerType: WorkerType;
  daysWorked: number;
  daysInMonth: number;
  earnings: Earning[];
  deductions: Deduction[];
  employer: EmployerCost[];
  gross: number;
  taxableIncome: number;
  totalDeductions: number;
  net: number;
  employerCost: number;
  tax: { regular: number; irregular: number; ytdTaxable: number; ytdTax: number; remaining: number; projectedAnnual: number; annualTax: number } | null;
  advanceRecoveries: { advanceId: string; amount: number }[];
  claimIds: string[];
}

/**
 * One person's month. Fixed pay (salary, retainer, fixed allowances) is prorated by calendar days employed;
 * incentives, bonuses and claims are not. Employees: salary tax (projected-annual), EOBI (on the minimum wage,
 * a full month whenever they are on payroll) and provident fund (% of prorated base salary). Contractors: no salary
 * tax / EOBI / PF; `withholdingPct` of their pay (claims excluded) is withheld instead. Net pay never goes below 0:
 * advance recovery and manual deductions are trimmed first.
 */
export function buildPayslip(i: PayslipInput): Payslip {
  const v = i.version;
  const p = proration(i.month, i.joiningDate, i.exitDate);
  const f = p.factor;
  const earnings: Earning[] = [];
  const add = (e: Earning) => { if (e.amount > 0) earnings.push({ ...e, amount: round2(e.amount) }); };

  add({ kind: 'base', label: 'Basic salary', amount: v.baseMonthlySalary * f, taxable: true, regular: true, meta: f < 1 ? { daysWorked: p.daysWorked, daysInMonth: p.daysInMonth } : null });
  add({ kind: 'retainer', label: 'Monthly retainer', amount: v.monthlyRetainer * f, taxable: true, regular: true });
  for (const a of v.allowances) add({ kind: 'allowance', label: a.name, amount: a.amount * f, taxable: !!a.taxable, regular: true });
  if (p.daysWorked > 0) {
    for (const r of v.incentiveRules) {
      const count = i.counts[r.metric] ?? 0;
      add({
        kind: 'incentive', label: r.label || METRIC_LABEL[r.metric], amount: incentiveAmount(r, count), taxable: true, regular: false,
        meta: { metric: r.metric, count: round2(count), rate: r.rate, unit: r.unit, minThreshold: r.minThreshold ?? null, cap: r.cap ?? null },
      });
    }
    for (const b of bonusesFor(v.bonusTiers, i.perf)) add({ kind: 'bonus', label: `Bonus: ${b.label}`, amount: b.bonus, taxable: true, regular: false, meta: { metric: b.metric, value: b.value, threshold: b.threshold } });
  }
  for (const c of i.claims) add({ kind: 'claim', label: c.label, amount: c.amount, taxable: c.taxable, regular: false, meta: { claimId: c.id, type: c.type } });
  for (const m of i.manual) if (m.type === 'addition') add({ kind: 'manual', label: m.label, amount: m.amount, taxable: m.taxable !== false, regular: false });

  const gross = round2(earnings.reduce((s, e) => s + e.amount, 0));
  const regular = round2(earnings.filter((e) => e.taxable && e.regular).reduce((s, e) => s + e.amount, 0));
  const irregular = round2(earnings.filter((e) => e.taxable && !e.regular).reduce((s, e) => s + e.amount, 0));

  const deductions: Deduction[] = [];
  const employer: EmployerCost[] = [];
  let taxInfo: Payslip['tax'] = null;
  const onPayroll = p.daysWorked > 0;

  if (v.workerType === 'employee') {
    const remaining = remainingMonths(i.month, i.exitDate);
    const w = monthlyWithholding({ regular, irregular, ytdTaxable: i.ytd.taxable, ytdTax: i.ytd.tax, remaining }, i.tax);
    taxInfo = { regular, irregular, ytdTaxable: round2(i.ytd.taxable), ytdTax: round2(i.ytd.tax), remaining, projectedAnnual: w.projectedAnnual, annualTax: w.annualTax };
    if (w.tax > 0) deductions.push({ kind: 'income_tax', label: 'Income tax (salary)', amount: w.tax });
    if (v.eobiEnabled && onPayroll) {
      deductions.push({ kind: 'eobi', label: 'EOBI (employee)', amount: round2((i.eobi.minimumWage * i.eobi.employeePct) / 100) });
      employer.push({ kind: 'eobi', label: 'EOBI (employer)', amount: round2((i.eobi.minimumWage * i.eobi.employerPct) / 100) });
    }
    const base = earnings.find((e) => e.kind === 'base')?.amount ?? 0;
    if (v.pfEnabled && base > 0) {
      if (v.pfEmployeePct > 0) deductions.push({ kind: 'pf', label: 'Provident fund (employee)', amount: round2((base * v.pfEmployeePct) / 100) });
      if (v.pfEmployerPct > 0) employer.push({ kind: 'pf', label: 'Provident fund (employer)', amount: round2((base * v.pfEmployerPct) / 100) });
    }
  } else if (v.withholdingPct > 0) {
    const payable = round2(earnings.filter((e) => e.kind !== 'claim').reduce((s, e) => s + e.amount, 0));
    const wh = round2((payable * v.withholdingPct) / 100);
    if (wh > 0) deductions.push({ kind: 'withholding', label: `Withholding tax (${v.withholdingPct}%)`, amount: wh });
  }

  // Statutory deductions first; then advances and manual deductions, trimmed so net pay never goes negative.
  let left = round2(gross - deductions.reduce((s, d) => s + d.amount, 0));
  const advanceRecoveries: { advanceId: string; amount: number }[] = [];
  for (const a of i.advances) {
    const want = round2(Math.min(a.outstanding, a.monthlyRecovery > 0 ? a.monthlyRecovery : a.outstanding));
    const take = round2(Math.max(0, Math.min(want, left)));
    if (take <= 0) continue;
    deductions.push({ kind: 'advance', label: 'Advance recovery', amount: take, meta: { advanceId: a.id } });
    advanceRecoveries.push({ advanceId: a.id, amount: take });
    left = round2(left - take);
  }
  for (const m of i.manual) {
    if (m.type !== 'deduction') continue;
    const take = round2(Math.max(0, Math.min(m.amount, left)));
    if (take <= 0) continue;
    deductions.push({ kind: 'manual', label: m.label, amount: take });
    left = round2(left - take);
  }

  const totalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0));
  return {
    workerType: v.workerType,
    daysWorked: p.daysWorked,
    daysInMonth: p.daysInMonth,
    earnings,
    deductions,
    employer,
    gross,
    taxableIncome: round2(regular + irregular),
    totalDeductions,
    net: round2(gross - totalDeductions),
    employerCost: round2(employer.reduce((s, e) => s + e.amount, 0)),
    tax: taxInfo,
    advanceRecoveries,
    claimIds: i.claims.map((c) => c.id),
  };
}

// ── Accounting ────────────────────────────────────────────────────────────────
export interface PayrollJournalLine { accountCode: string; debit?: number; credit?: number; party?: { type: 'employee'; id: string; name?: string | null } | null; description?: string | null }

/**
 * Accrual journal for an approved run. Expenses are summed per account; what the company owes each person (net pay,
 * account 2300) and what they owe back (advance recovery, 1300) carry the employee as party so the employee ledger
 * works. Manual deductions reduce the salary expense. Always balanced: debits = gross + employer costs; credits =
 * deductions + employer liabilities + net.
 */
export function accrualLines(people: { adminId: string; name: string | null; slip: Payslip }[], A: {
  salaries: string; allowances: string; incentives: string; employerEobi: string; employerPf: string; contractorFees: string; claims: string;
  advances: string; withholdingServices: string; incomeTaxWithheld: string; eobiPayable: string; pfPayable: string; salariesPayable: string;
}): PayrollJournalLine[] {
  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  const bump = (m: Map<string, number>, code: string, n: number) => { if (n > 0) m.set(code, round2((m.get(code) ?? 0) + n)); };
  const out: PayrollJournalLine[] = [];
  for (const { adminId, name, slip } of people) {
    const contractor = slip.workerType === 'contractor';
    for (const e of slip.earnings) {
      const code = e.kind === 'claim' ? A.claims
        : contractor ? A.contractorFees
          : e.kind === 'allowance' ? A.allowances
            : e.kind === 'incentive' || e.kind === 'bonus' ? A.incentives
              : A.salaries;
      bump(debit, code, e.amount);
    }
    for (const c of slip.employer) {
      bump(debit, c.kind === 'eobi' ? A.employerEobi : A.employerPf, c.amount);
      bump(credit, c.kind === 'eobi' ? A.eobiPayable : A.pfPayable, c.amount);
    }
    for (const d of slip.deductions) {
      if (d.kind === 'advance') {
        out.push({ accountCode: A.advances, credit: d.amount, party: { type: 'employee', id: adminId, name }, description: 'Advance recovered through payroll' });
        continue;
      }
      const code = d.kind === 'income_tax' ? A.incomeTaxWithheld
        : d.kind === 'eobi' ? A.eobiPayable
          : d.kind === 'pf' ? A.pfPayable
            : d.kind === 'withholding' ? A.withholdingServices
              : contractor ? A.contractorFees : A.salaries; // manual deductions reduce the pay expense
      bump(credit, code, d.amount);
    }
    if (slip.net > 0) out.push({ accountCode: A.salariesPayable, credit: slip.net, party: { type: 'employee', id: adminId, name }, description: 'Net pay owed' });
  }
  const lines: PayrollJournalLine[] = [
    ...[...debit].map(([accountCode, n]) => ({ accountCode, debit: n })),
    ...[...credit].map(([accountCode, n]) => ({ accountCode, credit: n })),
    ...out,
  ];
  // Net the same account appearing on both sides (e.g. salary expense and a manual deduction credited to it).
  const net = new Map<string, number>();
  const keep: PayrollJournalLine[] = [];
  for (const l of lines) {
    if (l.party) { keep.push(l); continue; }
    net.set(l.accountCode, round2((net.get(l.accountCode) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0)));
  }
  const merged: PayrollJournalLine[] = [...net].filter(([, n]) => Math.abs(n) >= 0.005).map(([accountCode, n]) => (n > 0 ? { accountCode, debit: n } : { accountCode, credit: round2(-n) }));
  return [...merged, ...keep];
}

// ── Masking ───────────────────────────────────────────────────────────────────
export const maskValue = (plain: string | null | undefined): string | null => {
  if (!plain) return null;
  const s = String(plain);
  return s.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
};
