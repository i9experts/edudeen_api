/**
 * Statutory payments: the money withheld or owed on payroll (FBR income tax on salaries, FBR withholding on
 * contractors, EOBI, provident fund) and what has been paid to each authority. Pure helpers only (no DB) so the
 * rules are unit-tested. Money is PKR, 2 dp.
 *
 * Edudeen does NOT pay FBR or EOBI itself (no API): finance pays through the bank (PSID / challan) and records the
 * CPR here. Due days are settings, defaulting to the 15th of the following month: finance must check them against
 * current FBR / EOBI rules.
 */
import { round2 } from '../accounting/accounting.util';
import type { ReportTable } from '../accounting/export.util';

export const AUTHORITIES = [
  'fbr_salary',
  'fbr_withholding',
  'eobi',
  'pf',
  'fbr_other',
] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const AUTHORITY_LABEL: Record<Authority, string> = {
  fbr_salary: 'FBR — income tax on salaries',
  fbr_withholding: 'FBR — withholding on contractor payments',
  eobi: 'EOBI contributions',
  pf: 'Provident fund',
  fbr_other: 'FBR — other withholding',
};

/** Ledger liability each authority's money sits in until paid (codes from accounting SEED_ACCOUNTS). */
export const AUTHORITY_ACCOUNT: Record<Authority, string> = {
  fbr_salary: '2220',
  fbr_withholding: '2210',
  eobi: '2230',
  pf: '2240',
  fbr_other: '2210',
};

/** Authorities generated automatically from approved payroll runs. */
export const PAYROLL_AUTHORITIES = [
  'fbr_salary',
  'fbr_withholding',
  'eobi',
  'pf',
] as const satisfies readonly Authority[];

export const PENALTY_ACCOUNT = '6910';

/** Day of the following month each authority is due. Defaults only: finance checks current FBR / EOBI rules. */
export type DueDays = Record<Authority, number>;
export const DEFAULT_DUE_DAYS: DueDays = {
  fbr_salary: 15,
  fbr_withholding: 15,
  eobi: 15,
  pf: 15,
  fbr_other: 15,
};

export const STATEMENT_STATUSES = [
  'pending',
  'submitted',
  'partially_paid',
  'paid',
  'void',
] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];
export const PAYMENT_STATUSES = ['submitted', 'approved', 'rejected'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Days before the due date the "due soon" reminder and dashboard alert start. */
export const DUE_SOON_DAYS = 5;

export const isMonth = (m: unknown): m is string =>
  typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

export function taxYearOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The 12 months of a July–June tax year, e.g. '2026-27' → 2026-07 … 2027-06. */
export function taxYearMonths(taxYear: string): string[] {
  const start = Number(taxYear.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => addMonths(`${start}-07`, i));
}

/** Sanitise due days from settings (1..28 keeps every month valid; anything else falls back to the default). */
export function cleanDueDays(
  raw: Partial<Record<string, unknown>> | null | undefined,
): DueDays {
  const out = { ...DEFAULT_DUE_DAYS };
  for (const a of AUTHORITIES) {
    const n = Number(raw?.[a]);
    if (Number.isInteger(n) && n >= 1 && n <= 28) out[a] = n;
  }
  return out;
}

/** Due date (UTC midnight) for a liability month: day N of the following month. */
export function dueDateFor(
  month: string,
  authority: Authority,
  dueDays: DueDays,
): Date {
  const next = addMonths(month, 1);
  const [y, m] = next.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dueDays[authority] ?? 15));
}

const DAY = 86_400_000;
const dayStart = (d: Date) =>
  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Whole days from `now` (by UTC date) to the due date: negative = overdue. */
export const daysUntil = (due: Date, now: Date) =>
  Math.round((dayStart(due) - dayStart(now)) / DAY);

export type DueState = 'paid' | 'void' | 'not_due' | 'due_soon' | 'overdue';
export function dueState(
  s: { status: StatementStatus; dueDate: Date | string },
  now: Date,
): DueState {
  if (s.status === 'paid') return 'paid';
  if (s.status === 'void') return 'void';
  const d = daysUntil(new Date(s.dueDate), now);
  if (d < 0) return 'overdue';
  if (d <= DUE_SOON_DAYS) return 'due_soon';
  return 'not_due';
}

/** Which reminder (if any) is owed now. Each kind is sent once per statement (sentAt flags are the idempotency). */
export function reminderDue(
  s: {
    status: StatementStatus;
    dueDate: Date | string;
    reminders?: {
      dueSoonSentAt?: Date | null;
      overdueSentAt?: Date | null;
    } | null;
  },
  now: Date,
): 'due_soon' | 'overdue' | null {
  const st = dueState(s, now);
  if (st === 'overdue' && !s.reminders?.overdueSentAt) return 'overdue';
  if (st === 'due_soon' && !s.reminders?.dueSoonSentAt) return 'due_soon';
  return null;
}

// ── Statement lines from a payroll run ───────────────────────────────────────
export interface StatementLine {
  adminId: string | null;
  name: string;
  workerType: 'employee' | 'contractor' | null;
  cnicLast4: string | null;
  ntnLast4: string | null;
  eobiNumber: string | null;
  /** fbr_salary: taxable income of the month; fbr_withholding: pay the % was taken on. */
  taxableIncome: number | null;
  /** EOBI wage base (minimum wage) used. */
  wageBase: number | null;
  employeeShare: number;
  employerShare: number;
  /** employeeShare + employerShare (what is owed for this person). */
  amount: number;
  description: string | null;
}

interface RunLine {
  adminId: string;
  name?: string | null;
  email?: string | null;
  excluded?: boolean;
  workerType?: 'employee' | 'contractor';
  taxableIncome?: number;
  earnings?: { kind: string; amount: number }[];
  deductions?: { kind: string; amount: number }[];
  employer?: { kind: string; amount: number }[];
}
export interface ProfileIds {
  cnicLast4: string | null;
  ntnLast4: string | null;
  eobiNumber: string | null;
}

const sumKind = (
  rows: { kind: string; amount: number }[] | undefined,
  kind: string,
) =>
  round2(
    (rows ?? [])
      .filter((r) => r.kind === kind)
      .reduce((s, r) => s + (Number(r.amount) || 0), 0),
  );

/**
 * One statement per authority for an approved run, from the very payslip lines the accrual journal was built from
 * (payroll.util accrualLines), so amounts tie to the ledger. Authorities with nothing owed are left out.
 */
export function statementsFromRun(
  run: { lines: RunLine[] },
  profiles: Map<string, ProfileIds>,
  eobiWageBase: number | null,
): { authority: Authority; lines: StatementLine[]; amount: number }[] {
  const out: {
    authority: Authority;
    lines: StatementLine[];
    amount: number;
  }[] = [];
  const people = (run.lines ?? []).filter((l) => !l.excluded);
  const idsOf = (l: RunLine) =>
    profiles.get(l.adminId) ?? {
      cnicLast4: null,
      ntnLast4: null,
      eobiNumber: null,
    };
  const base = (l: RunLine) => ({
    adminId: l.adminId,
    name: l.name || l.email || l.adminId,
    workerType: l.workerType ?? null,
    ...idsOf(l),
    description: null,
  });
  const push = (authority: Authority, lines: StatementLine[]) => {
    const kept = lines.filter((x) => x.amount > 0);
    const amount = round2(kept.reduce((s, x) => s + x.amount, 0));
    if (amount > 0) out.push({ authority, lines: kept, amount });
  };

  push(
    'fbr_salary',
    people.map((l) => {
      const tax = sumKind(l.deductions, 'income_tax');
      return {
        ...base(l),
        taxableIncome: round2(l.taxableIncome ?? 0),
        wageBase: null,
        employeeShare: tax,
        employerShare: 0,
        amount: tax,
      };
    }),
  );
  push(
    'fbr_withholding',
    people.map((l) => {
      const wh = sumKind(l.deductions, 'withholding');
      const payable = round2(
        (l.earnings ?? [])
          .filter((e) => e.kind !== 'claim')
          .reduce((s, e) => s + (Number(e.amount) || 0), 0),
      );
      return {
        ...base(l),
        taxableIncome: payable,
        wageBase: null,
        employeeShare: wh,
        employerShare: 0,
        amount: wh,
      };
    }),
  );
  push(
    'eobi',
    people.map((l) => {
      const emp = sumKind(l.deductions, 'eobi');
      const er = sumKind(l.employer, 'eobi');
      return {
        ...base(l),
        taxableIncome: null,
        wageBase: emp || er ? eobiWageBase : null,
        employeeShare: emp,
        employerShare: er,
        amount: round2(emp + er),
      };
    }),
  );
  push(
    'pf',
    people.map((l) => {
      const emp = sumKind(l.deductions, 'pf');
      const er = sumKind(l.employer, 'pf');
      return {
        ...base(l),
        taxableIncome: null,
        wageBase: null,
        employeeShare: emp,
        employerShare: er,
        amount: round2(emp + er),
      };
    }),
  );
  return out;
}

/** Net credit (credit − debit) a journal put on one account: the liability the run accrued for that authority. */
export function accruedOnAccount(
  journal: {
    lines?: { accountCode: string; debit?: number; credit?: number }[];
  } | null,
  accountCode: string,
): number {
  if (!journal) return 0;
  return round2(
    (journal.lines ?? [])
      .filter((l) => l.accountCode === accountCode)
      .reduce(
        (s, l) => s + (Number(l.credit) || 0) - (Number(l.debit) || 0),
        0,
      ),
  );
}

// ── Payments ─────────────────────────────────────────────────────────────────
export interface PaymentLike {
  status: PaymentStatus;
  amount: number;
  penalty?: number;
}

/** Paid = approved payments; pending = submitted, waiting for approval. Penalties are on top and never reduce the debt. */
export function paymentTotals(amount: number, payments: PaymentLike[]) {
  const paid = round2(
    payments
      .filter((p) => p.status === 'approved')
      .reduce((s, p) => s + p.amount, 0),
  );
  const pending = round2(
    payments
      .filter((p) => p.status === 'submitted')
      .reduce((s, p) => s + p.amount, 0),
  );
  const penalties = round2(
    payments
      .filter((p) => p.status === 'approved')
      .reduce((s, p) => s + (p.penalty ?? 0), 0),
  );
  return {
    amount: round2(amount),
    paid,
    pending,
    penalties,
    remaining: round2(Math.max(0, amount - paid)),
    unclaimed: round2(Math.max(0, amount - paid - pending)),
  };
}

export function statusFor(
  amount: number,
  payments: PaymentLike[],
  current: StatementStatus,
): StatementStatus {
  if (current === 'void') return 'void';
  const t = paymentTotals(amount, payments);
  if (t.paid > 0 && t.remaining <= 0.004) return 'paid';
  if (t.pending > 0) return 'submitted';
  if (t.paid > 0) return 'partially_paid';
  return 'pending';
}

/**
 * Payment journal: Dr the authority's liability (amount) + Dr Penalties & fines (penalty) / Cr the bank (both).
 * No party on the liability line: payroll accrues these liabilities as one total per run (accrualLines), so a
 * per-employee party here would leave the employee ledgers unbalanced. The statement keeps the per-person detail.
 */
export function paymentJournalLines(input: {
  liabilityAccount: string;
  bankAccount: string;
  amount: number;
  penalty: number;
  label: string;
}) {
  const amount = round2(input.amount);
  const penalty = round2(Math.max(0, input.penalty || 0));
  const lines: {
    accountCode: string;
    debit?: number;
    credit?: number;
    description: string;
  }[] = [
    {
      accountCode: input.liabilityAccount,
      debit: amount,
      description: input.label,
    },
  ];
  if (penalty > 0)
    lines.push({
      accountCode: PENALTY_ACCOUNT,
      debit: penalty,
      description: `Late payment penalty / default surcharge — ${input.label}`,
    });
  lines.push({
    accountCode: input.bankAccount,
    credit: round2(amount + penalty),
    description: input.label,
  });
  return lines;
}

// ── Liability overview ───────────────────────────────────────────────────────
export const LIABILITY_AGING = [
  'not_due',
  'overdue_0_30',
  'overdue_31_60',
  'overdue_60_plus',
] as const;
export type LiabilityAging = (typeof LIABILITY_AGING)[number];
export function agingOf(dueDate: Date | string, now: Date): LiabilityAging {
  const d = daysUntil(new Date(dueDate), now);
  if (d >= 0) return 'not_due';
  if (-d <= 30) return 'overdue_0_30';
  if (-d <= 60) return 'overdue_31_60';
  return 'overdue_60_plus';
}

// ── Filing working files ─────────────────────────────────────────────────────
export interface FilingRow {
  month: string;
  name: string;
  cnic: string;
  ntn: string;
  eobiNumber?: string;
  taxableIncome?: number | null;
  wageBase?: number | null;
  employeeShare: number;
  employerShare: number;
  amount: number;
  psid: string;
  cpr: string;
  paymentDate: string;
}

const NOTE =
  'WORKING FILE — check the format against the current IRIS / EOBI template before filing.';

export function salaryTaxTable(rows: FilingRow[], period: string): ReportTable {
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const taxable = round2(rows.reduce((s, r) => s + (r.taxableIncome ?? 0), 0));
  return {
    title: 'Salary tax deducted — employee-wise (Section 149)',
    subtitle: `${period} · ${NOTE}`,
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'cnic', label: 'CNIC' },
      { key: 'name', label: 'Name' },
      { key: 'ntn', label: 'NTN' },
      { key: 'taxableIncome', label: 'Taxable income (PKR)', align: 'right' },
      { key: 'amount', label: 'Tax deducted (PKR)', align: 'right' },
      { key: 'psid', label: 'PSID' },
      { key: 'cpr', label: 'CPR number' },
      { key: 'paymentDate', label: 'Payment date' },
    ],
    rows: [
      ...rows.map((r) => ({ ...r })),
      { month: 'Total', taxableIncome: taxable, amount: total, _bold: 1 },
    ],
  };
}

export function contractorWithholdingTable(
  rows: FilingRow[],
  period: string,
): ReportTable {
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const paid = round2(rows.reduce((s, r) => s + (r.taxableIncome ?? 0), 0));
  return {
    title: 'Withholding tax on contractor payments',
    subtitle: `${period} · ${NOTE}`,
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'cnic', label: 'CNIC' },
      { key: 'ntn', label: 'NTN' },
      { key: 'name', label: 'Name' },
      { key: 'taxableIncome', label: 'Amount paid (PKR)', align: 'right' },
      { key: 'amount', label: 'Tax withheld (PKR)', align: 'right' },
      { key: 'psid', label: 'PSID' },
      { key: 'cpr', label: 'CPR number' },
      { key: 'paymentDate', label: 'Payment date' },
    ],
    rows: [
      ...rows.map((r) => ({ ...r })),
      { month: 'Total', taxableIncome: paid, amount: total, _bold: 1 },
    ],
  };
}

export function eobiTable(rows: FilingRow[], period: string): ReportTable {
  const t = (k: 'employeeShare' | 'employerShare' | 'amount') =>
    round2(rows.reduce((s, r) => s + r[k], 0));
  return {
    title: 'EOBI contributions',
    subtitle: `${period} · ${NOTE}`,
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'name', label: 'Name' },
      { key: 'cnic', label: 'CNIC' },
      { key: 'eobiNumber', label: 'EOBI number' },
      { key: 'wageBase', label: 'Wage base (PKR)', align: 'right' },
      { key: 'employeeShare', label: 'Employee share', align: 'right' },
      { key: 'employerShare', label: 'Employer share', align: 'right' },
      { key: 'amount', label: 'Total', align: 'right' },
      { key: 'cpr', label: 'Challan / CPR' },
      { key: 'paymentDate', label: 'Payment date' },
    ],
    rows: [
      ...rows.map((r) => ({ ...r })),
      {
        month: 'Total',
        employeeShare: t('employeeShare'),
        employerShare: t('employerShare'),
        amount: t('amount'),
        _bold: 1,
      },
    ],
  };
}

/** Masks an identity number to its last 4 characters (exports without the full-CNIC right). */
export const maskId = (last4: string | null | undefined) =>
  last4 ? `•••••${last4}` : '';
