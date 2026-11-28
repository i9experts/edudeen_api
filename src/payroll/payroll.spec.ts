/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- mock-heavy */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PAYROLL_ACCOUNTS } from './payroll.constants';
import {
  accrualLines, annualTax, bonusesFor, buildPayslip, emptyCounts, incentiveAmount, maskValue, monthlyWithholding, proration, remainingMonths,
  taxYearOf, versionFor, type PayVersion, type PayslipInput, type PerfFigures, type TaxRules,
} from './payroll.util';
import { PayrollService } from './payroll.service';

const RULES: TaxRules = {
  slabs: [
    { from: 0, to: 600_000, fixed: 0, rate: 0 },
    { from: 600_000, to: 1_200_000, fixed: 0, rate: 1 },
    { from: 1_200_000, to: 2_200_000, fixed: 6_000, rate: 11 },
    { from: 2_200_000, to: 3_200_000, fixed: 116_000, rate: 23 },
    { from: 3_200_000, to: 4_100_000, fixed: 346_000, rate: 30 },
    { from: 4_100_000, to: null, fixed: 616_000, rate: 35 },
  ],
  surcharge: { threshold: 10_000_000, pct: 9 },
};
const EOBI = { minimumWage: 37_000, employeePct: 1, employerPct: 5 };
const perf = (p: Partial<PerfFigures> = {}): PerfFigures => ({
  on_time_pct: null, on_time_sample: 0, reply_within_24h_pct: null, reply_sample: 0, orders_handled: 0, products_listed: 0, sellers_onboarded: 0, support_replies: 0, ...p,
});
const version = (v: Partial<PayVersion> = {}): PayVersion => ({
  effectiveFrom: '2026-07', workerType: 'employee', baseMonthlySalary: 100_000, monthlyRetainer: 0, allowances: [], incentiveRules: [], bonusTiers: [], claimRates: [],
  eobiEnabled: true, pfEnabled: false, pfEmployeePct: 0, pfEmployerPct: 0, withholdingPct: 0, ...v,
});
const slipInput = (i: Partial<PayslipInput> = {}): PayslipInput => ({
  month: '2026-07', version: version(), joiningDate: null, exitDate: null, counts: emptyCounts(), perf: perf(), claims: [], advances: [], manual: [],
  ytd: { taxable: 0, tax: 0 }, tax: RULES, eobi: EOBI, ...i,
});

describe('salary tax slabs', () => {
  it.each([
    [0, 0], [600_000, 0], [600_100, 1], [1_200_000, 6_000], [1_200_100, 6_011], [2_200_000, 116_000], [3_200_000, 346_000], [4_100_000, 616_000],
    [5_000_000, 931_000],
  ])('annual tax on %d = %d', (income, tax) => {
    expect(annualTax(income, RULES)).toBe(tax);
  });

  it('adds the 9% surcharge only above 10 million', () => {
    expect(annualTax(10_000_000, RULES)).toBe(616_000 + 0.35 * 5_900_000);
    expect(annualTax(12_000_000, RULES)).toBe(Math.round((616_000 + 0.35 * 7_900_000) * 1.09 * 100) / 100);
  });
});

describe('monthly withholding (projected annual)', () => {
  it('spreads a steady salary evenly over the year', () => {
    const w = monthlyWithholding({ regular: 100_000, irregular: 0, ytdTaxable: 0, ytdTax: 0, remaining: 12 }, RULES);
    expect(w.tax).toBe(500); // 1.2M -> 6,000 a year
  });

  it('taxes a one-off bonus fully in its month at the marginal rate', () => {
    const w = monthlyWithholding({ regular: 100_000, irregular: 50_000, ytdTaxable: 0, ytdTax: 0, remaining: 12 }, RULES);
    expect(w.tax).toBe(500 + 5_500); // 11% of 50,000 above 1.2M
  });

  it('a January joiner is projected over the months left only', () => {
    expect(remainingMonths('2027-01', null)).toBe(6);
    const w = monthlyWithholding({ regular: 150_000, irregular: 0, ytdTaxable: 0, ytdTax: 0, remaining: 6 }, RULES);
    expect(w.tax).toBe(500); // 900,000 -> 3,000 over 6 months
  });

  it('the exit month trues up any shortfall', () => {
    expect(remainingMonths('2026-11', new Date(Date.UTC(2026, 10, 15)))).toBe(1);
    const w = monthlyWithholding({ regular: 100_000, irregular: 0, ytdTaxable: 1_100_000, ytdTax: 0, remaining: 1 }, RULES);
    expect(w.tax).toBe(6_000);
  });

  it('never goes negative when too much was withheld earlier', () => {
    expect(monthlyWithholding({ regular: 50_000, irregular: 0, ytdTaxable: 300_000, ytdTax: 20_000, remaining: 6 }, RULES).tax).toBe(0);
  });

  it('labels tax years July..June', () => {
    expect(taxYearOf('2026-07')).toBe('2026-27');
    expect(taxYearOf('2027-06')).toBe('2026-27');
    expect(taxYearOf('2027-07')).toBe('2027-28');
  });
});

describe('proration, versions, incentives and bonuses', () => {
  it('prorates by calendar days employed (joining and exit days count)', () => {
    expect(proration('2026-09', new Date(Date.UTC(2026, 8, 16)), null)).toEqual({ daysWorked: 15, daysInMonth: 30, factor: 0.5 });
    expect(proration('2026-09', null, new Date(Date.UTC(2026, 8, 10))).daysWorked).toBe(10);
    expect(proration('2026-09', new Date(Date.UTC(2026, 9, 1)), null).daysWorked).toBe(0);
  });

  it('uses the latest version in force for the month', () => {
    const vs = [{ effectiveFrom: '2026-07', n: 1 }, { effectiveFrom: '2026-10', n: 2 }];
    expect(versionFor(vs, '2026-09')?.n).toBe(1);
    expect(versionFor(vs, '2026-10')?.n).toBe(2);
    expect(versionFor(vs, '2026-06')).toBeNull();
  });

  it('incentives: threshold, cap and percent of commission', () => {
    expect(incentiveAmount({ metric: 'products_listed', rate: 50, unit: 'per_unit', minThreshold: 20 }, 19)).toBe(0);
    expect(incentiveAmount({ metric: 'products_listed', rate: 50, unit: 'per_unit', minThreshold: 20 }, 25)).toBe(1_250);
    expect(incentiveAmount({ metric: 'shipments_handled', rate: 100, unit: 'per_unit', cap: 3_000 }, 45)).toBe(3_000);
    expect(incentiveAmount({ metric: 'managed_store_commission', rate: 5, unit: 'percent' }, 80_000)).toBe(4_000);
  });

  it('bonus tiers: highest tier per measure, percent tiers need a sample', () => {
    const tiers = [
      { metric: 'on_time_pct' as const, threshold: 90, bonus: 2_000 },
      { metric: 'on_time_pct' as const, threshold: 95, bonus: 5_000, minSample: 10 },
      { metric: 'orders_handled' as const, threshold: 100, bonus: 3_000 },
    ];
    expect(bonusesFor(tiers, perf({ on_time_pct: 97, on_time_sample: 20, orders_handled: 120 })).map((b) => b.bonus).sort()).toEqual([3_000, 5_000]);
    expect(bonusesFor(tiers, perf({ on_time_pct: 97, on_time_sample: 5 })).map((b) => b.bonus)).toEqual([2_000]);
    expect(bonusesFor(tiers, perf({ on_time_pct: null }))).toEqual([]);
  });
});

describe('payslip', () => {
  it('employee: salary tax, EOBI on the minimum wage, provident fund on basic', () => {
    const s = buildPayslip(slipInput({ version: version({ pfEnabled: true, pfEmployeePct: 5, pfEmployerPct: 5, allowances: [{ name: 'Petrol', amount: 8_000, taxable: false }] }) }));
    expect(s.gross).toBe(108_000);
    expect(s.taxableIncome).toBe(100_000);
    const d = Object.fromEntries(s.deductions.map((x) => [x.kind, x.amount]));
    expect(d).toEqual({ income_tax: 500, eobi: 370, pf: 5_000 });
    expect(s.employer).toEqual([{ kind: 'eobi', label: 'EOBI (employer)', amount: 1_850 }, { kind: 'pf', label: 'Provident fund (employer)', amount: 5_000 }]);
    expect(s.net).toBe(108_000 - 500 - 370 - 5_000);
  });

  it('employee: incentives and bonuses are taxable one-offs; claims are tax-free reimbursements', () => {
    const counts = { ...emptyCounts(), products_listed: 40 };
    const s = buildPayslip(slipInput({
      counts, perf: perf({ orders_handled: 120 }),
      version: version({ incentiveRules: [{ metric: 'products_listed', rate: 100, unit: 'per_unit' }], bonusTiers: [{ metric: 'orders_handled', threshold: 100, bonus: 6_000 }] }),
      claims: [{ id: 'c1', type: 'petrol', amount: 2_500, taxable: false, label: 'Petrol claim' }],
    }));
    expect(s.earnings.map((e) => [e.kind, e.amount])).toEqual([['base', 100_000], ['incentive', 4_000], ['bonus', 6_000], ['claim', 2_500]]);
    expect(s.taxableIncome).toBe(110_000);
    expect(s.deductions.find((d) => d.kind === 'income_tax')?.amount).toBe(500 + 1_100); // 11% of the 10,000 one-off
    expect(s.claimIds).toEqual(['c1']);
  });

  it('contractor: no salary tax/EOBI/PF, withholding on pay excluding claims', () => {
    const s = buildPayslip(slipInput({
      version: version({ workerType: 'contractor', baseMonthlySalary: 0, monthlyRetainer: 50_000, withholdingPct: 10, eobiEnabled: false }),
      claims: [{ id: 'c1', type: 'travel', amount: 5_000, taxable: false, label: 'Travel' }],
    }));
    expect(s.deductions).toEqual([{ kind: 'withholding', label: 'Withholding tax (10%)', amount: 5_000 }]);
    expect(s.tax).toBeNull();
    expect(s.net).toBe(50_000);
  });

  it('advance recovery and manual deductions never push net pay below zero', () => {
    const s = buildPayslip(slipInput({
      version: version({ baseMonthlySalary: 30_000, eobiEnabled: false }),
      advances: [{ id: 'a1', outstanding: 50_000, monthlyRecovery: 25_000 }],
      manual: [{ type: 'deduction', label: 'Absence', amount: 10_000 }],
    }));
    expect(s.advanceRecoveries).toEqual([{ advanceId: 'a1', amount: 25_000 }]);
    expect(s.deductions.find((d) => d.kind === 'manual')?.amount).toBe(5_000);
    expect(s.net).toBe(0);
  });

  it('nobody employed in the month gets no incentive, EOBI or salary', () => {
    const s = buildPayslip(slipInput({ joiningDate: new Date(Date.UTC(2026, 7, 1)), counts: { ...emptyCounts(), products_listed: 10 }, version: version({ incentiveRules: [{ metric: 'products_listed', rate: 100, unit: 'per_unit' }] }) }));
    expect(s.gross).toBe(0);
    expect(s.deductions).toEqual([]);
    expect(s.employer).toEqual([]);
  });
});

describe('payroll journal', () => {
  it('accrual is balanced and puts the employee on payable / advance lines', () => {
    const a = buildPayslip(slipInput({
      version: version({ pfEnabled: true, pfEmployeePct: 5, pfEmployerPct: 5, allowances: [{ name: 'Lunch', amount: 5_000, taxable: false }], incentiveRules: [{ metric: 'shipments_handled', rate: 100, unit: 'per_unit' }] }),
      counts: { ...emptyCounts(), shipments_handled: 30 },
      advances: [{ id: 'adv', outstanding: 10_000, monthlyRecovery: 4_000 }],
      manual: [{ type: 'deduction', label: 'Absence', amount: 2_000 }],
      claims: [{ id: 'c', type: 'petrol', amount: 1_234.56, taxable: false, label: 'Petrol' }],
    }));
    const b = buildPayslip(slipInput({ version: version({ workerType: 'contractor', baseMonthlySalary: 0, monthlyRetainer: 40_000, withholdingPct: 8, eobiEnabled: false }) }));
    const lines = accrualLines([{ adminId: 'e1', name: 'Ali', slip: a }, { adminId: 'k1', name: 'Sara', slip: b }], PAYROLL_ACCOUNTS);
    const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));
    // Debits = gross pay + employer costs, less the manual deduction (2,000) netted against the salary expense.
    expect(Math.round(dr * 100)).toBe(Math.round((a.gross + a.employerCost + b.gross - 2_000) * 100));
    const payable = lines.filter((l) => l.accountCode === PAYROLL_ACCOUNTS.salariesPayable);
    expect(payable.map((l) => [l.party?.id, l.credit])).toEqual([['e1', a.net], ['k1', b.net]]);
    expect(lines.find((l) => l.accountCode === PAYROLL_ACCOUNTS.advances)).toMatchObject({ credit: 4_000, party: { type: 'employee', id: 'e1' } });
    expect(lines.find((l) => l.accountCode === PAYROLL_ACCOUNTS.withholdingServices)?.credit).toBe(3_200);
    expect(lines.find((l) => l.accountCode === PAYROLL_ACCOUNTS.contractorFees)?.debit).toBe(40_000);
    expect(lines.find((l) => l.accountCode === PAYROLL_ACCOUNTS.claims)?.debit).toBe(1_234.56);
    // Manual deduction nets against the salary expense rather than appearing on both sides.
    expect(lines.filter((l) => l.accountCode === PAYROLL_ACCOUNTS.salaries)).toHaveLength(1);
  });

  it('masks identity values to the last 4', () => {
    expect(maskValue('3520212345671')).toBe('••••••••5671');
    expect(maskValue('123')).toBe('••••');
    expect(maskValue(null)).toBeNull();
  });
});

// ── Service: permissions, state machine, idempotent posting, encryption ───────
const owner = { id: 'owner', isOwner: true, permissions: null };
const staff = (id: string, perms: string[] = []) => ({ id, isOwner: false, permissions: new Set(perms) });

function fakeDoc(data: any) {
  const doc: any = { ...data, save: jest.fn(async () => doc), toObject: () => ({ ...doc }), markModified: jest.fn() };
  return doc;
}

function makeService(over: Partial<Record<string, any>> = {}) {
  const ledger = { postJournal: jest.fn(async (i: any) => ({ entry: { _id: `j-${i.source?.id}` }, duplicate: false })), accountMap: jest.fn(async () => new Map([['1010', { code: '1010', type: 'asset', subtype: 'bank', isActive: true }]])) };
  const activity = { log: jest.fn(async () => true) };
  const db: any = { repositories: { adminModel: { find: () => ({ select: () => ({ lean: async () => [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ali' }, { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Boss' }] }) }) } } };
  const svc = new PayrollService(
    db, activity as any, {} as any, ledger as any, {} as any,
    over.profiles ?? ({} as any), over.taxYears ?? ({} as any), over.claims ?? ({} as any), over.advances ?? ({} as any), over.runs ?? ({} as any),
  );
  return { svc, ledger, activity };
}

describe('claim decisions', () => {
  const claimModel = (claim: any) => ({ findById: jest.fn(async () => claim) });
  const profiles = (managerOf: Record<string, string>) => ({
    find: jest.fn((q: any) => ({ select: () => ({ lean: async () => Object.entries(managerOf).filter(([, m]) => m === q.managerId).map(([adminId]) => ({ adminId })) }) })),
  });

  it('their manager can approve; someone else cannot; nobody approves their own', async () => {
    const claim = fakeDoc({ _id: 'c1', adminId: 'emp', status: 'submitted', type: 'petrol', amount: 900, taxable: false });
    const { svc } = makeService({ claims: claimModel(claim), profiles: profiles({ emp: 'mgr' }) });
    await expect(svc.decideClaim(staff('other') as any, 'c1', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.decideClaim(staff('emp', ['claims.approve']) as any, 'c1', true)).rejects.toBeInstanceOf(ForbiddenException);
    const out = await svc.decideClaim(staff('mgr') as any, 'c1', true);
    expect(out.status).toBe('approved');
    expect(out.decidedBy).toBe('mgr');
  });

  it('claims.approve decides anyone’s; a rejection needs a reason', async () => {
    const claim = fakeDoc({ _id: 'c2', adminId: 'emp', status: 'submitted', type: 'lunch', amount: 500 });
    const { svc } = makeService({ claims: claimModel(claim), profiles: profiles({}) });
    await expect(svc.decideClaim(staff('fin', ['claims.approve']) as any, 'c2', false)).rejects.toBeInstanceOf(BadRequestException);
    expect((await svc.decideClaim(staff('fin', ['claims.approve']) as any, 'c2', false, 'No receipt')).status).toBe('rejected');
  });
});

describe('payroll run approval', () => {
  const runDoc = (over: any = {}) => fakeDoc({
    _id: 'run1', month: '2026-07', taxYear: '2026-27', status: 'submitted', preparedBy: 'prep', submittedBy: 'prep', history: [],
    lines: [{ adminId: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ali', excluded: false, ...buildPayslip(slipInput()), paid: null }], totals: { net: 1, people: 1 }, ...over,
  });
  const models = (run: any, verified: boolean) => ({
    runs: { findById: jest.fn(() => {
      const p: any = Promise.resolve(run);
      p.lean = async () => ({ ...run });
      return p;
    }) },
    taxYears: { findOne: jest.fn(() => ({ lean: async () => ({ year: '2026-27', needsVerification: !verified }), select: () => ({ lean: async () => ({ needsVerification: !verified }) }) })) },
    claims: { updateMany: jest.fn(async () => ({})) },
    advances: { updateOne: jest.fn(async () => ({})) },
  });

  it('needs payroll.approve and a different person than the preparer', async () => {
    const run = runDoc();
    const { svc } = makeService(models(run, true));
    await expect(svc.approve(staff('x', ['payroll.prepare']) as any, 'run1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.approve(staff('prep', ['payroll.approve']) as any, 'run1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is blocked while the tax year is unverified', async () => {
    const { svc } = makeService(models(runDoc(), false));
    await expect(svc.approve(owner as any, 'run1')).rejects.toThrow(/not verified/);
  });

  it('posts one idempotent accrual journal and locks the run', async () => {
    const run = runDoc();
    const { svc, ledger } = makeService(models(run, true));
    jest.spyOn(svc, 'getRun').mockResolvedValue({} as any);
    await svc.approve(staff('boss', ['payroll.approve']) as any, 'run1');
    expect(ledger.postJournal).toHaveBeenCalledTimes(1);
    const call = ledger.postJournal.mock.calls[0][0];
    expect(call.source).toMatchObject({ type: 'payroll', id: 'run:run1:accrual' });
    const dr = call.lines.reduce((s: number, l: any) => s + (l.debit ?? 0), 0);
    const cr = call.lines.reduce((s: number, l: any) => s + (l.credit ?? 0), 0);
    expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));
    expect(run.status).toBe('approved');
    expect(run.accrualJournalId).toBe('j-run:run1:accrual');
  });

  it('only a submitted run can be approved', async () => {
    const { svc } = makeService(models(runDoc({ status: 'draft' }), true));
    await expect(svc.approve(owner as any, 'run1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('payments post one journal per person and never pay twice', async () => {
    const run = runDoc({ status: 'approved' });
    const { svc, ledger } = makeService(models(run, true));
    jest.spyOn(svc, 'getRun').mockResolvedValue({} as any);
    await svc.pay(owner as any, 'run1', { date: '2026-08-01', account: '1010' });
    expect(ledger.postJournal).toHaveBeenCalledTimes(1);
    expect(ledger.postJournal.mock.calls[0][0].source.id).toBe('run:run1:pay:aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(run.status).toBe('paid');
    await expect(svc.pay(owner as any, 'run1', {})).rejects.toThrow(/Nothing left to pay/);
  });
});

describe('pay profile secrets', () => {
  it('stores CNIC and bank account encrypted, keeps only the last 4 readable', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-payroll-spec-0123456789';
    const saved: any[] = [];
    class FakeProfile {
      [k: string]: any;
      constructor(d: any) { Object.assign(this, d, { isNew: true }); }
      async save() { saved.push({ ...this }); return this; }
    }
    const profiles: any = Object.assign(FakeProfile, {
      findOne: jest.fn((q: any) => {
        const p: any = Promise.resolve(saved.length ? null : null);
        p.lean = async () => (saved.length && q.adminId ? saved[saved.length - 1] : null);
        p.select = () => ({ lean: async () => null });
        return p;
      }),
    });
    const runs: any = { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }) };
    const { svc } = makeService({ profiles, runs });
    await svc.saveProfile(owner as any, 'aaaaaaaaaaaaaaaaaaaaaaaa', {
      cnic: '35202-1234567-1', bankAccount: 'PK36SCBL0000001123456702',
      version: { effectiveFrom: '2026-07', workerType: 'employee', baseMonthlySalary: 80_000 },
    });
    const doc = saved[0];
    expect(doc.cnicEnc).toBeTruthy();
    expect(doc.cnicEnc).not.toContain('1234567');
    expect(doc.cnicLast4).toBe('5671');
    expect(doc.bankAccountLast4).toBe('6702');
    expect(doc.versions[0]).toMatchObject({ effectiveFrom: '2026-07', baseMonthlySalary: 80_000, eobiEnabled: true });
  });

  it('rejects a percent rule on a count and a per-unit rule on commission', async () => {
    const { svc } = makeService();
    expect(() => (svc as any).cleanVersion({ effectiveFrom: '2026-07', workerType: 'employee', incentiveRules: [{ metric: 'products_listed', unit: 'percent', rate: 5 }] })).toThrow(BadRequestException);
    expect((svc as any).cleanVersion({ effectiveFrom: '2026-07', workerType: 'employee', incentiveRules: [{ metric: 'managed_store_commission', rate: 5 }] }).incentiveRules[0].unit).toBe('percent');
    expect(() => (svc as any).cleanVersion({ effectiveFrom: '2026-07', workerType: 'employee', bonusTiers: [{ metric: 'on_time_pct', threshold: 120, bonus: 1 }] })).toThrow(BadRequestException);
  });
});

describe('payroll staff permissions', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { permissionForRequest } = require('../staff/permissions') as typeof import('../staff/permissions');
  it.each([
    ['GET', '/api/admin/payroll/me', null],
    ['POST', '/api/admin/payroll/me/claims', null],
    ['POST', '/api/admin/payroll/claims/abc/approve', null],
    ['GET', '/api/admin/payroll/runs', 'payroll.view'],
    ['POST', '/api/admin/payroll/runs', 'payroll.prepare'],
    ['PUT', '/api/admin/payroll/profiles/abc', 'payroll.prepare'],
    ['POST', '/api/admin/payroll/runs/abc/approve', 'payroll.approve'],
    ['POST', '/api/admin/payroll/runs/abc/pay', 'payroll.approve'],
    ['POST', '/api/admin/payroll/advances/abc/approve', 'payroll.approve'],
    ['POST', '/api/admin/payroll/tax-years/2026-27/verify', 'payroll.approve'],
    ['GET', '/api/admin/payroll/profiles/abc/identity', 'payroll.approve'],
  ])('%s %s -> %s', (method, path, perm) => {
    expect(permissionForRequest(method, path)).toBe(perm);
  });
});

describe('payslip PDF', () => {
  it('renders a PDF for a payslip line', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renderPayslipPdf } = require('./payslip.pdf') as typeof import('./payslip.pdf');
    const slip = buildPayslip(slipInput({ version: version({ allowances: [{ name: 'Petrol', amount: 8_000, taxable: false }] }) }));
    const pdf = await renderPayslipPdf({ run: { month: '2026-07', status: 'approved' }, line: { adminId: 'x', name: 'Ali Raza — Ops', ...slip }, profile: { bankName: 'Meezan', bankAccount: '••••6702', cnic: '••••5671', designation: 'Store operator' } });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
