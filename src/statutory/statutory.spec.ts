/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- mock-heavy */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { sendMail } from '../common/mailer.util';

jest.mock('../common/mailer.util', () => ({
  sendMail: jest.fn(async () => 'id'),
}));
import { accrualLines } from '../payroll/payroll.util';
import { PAYROLL_ACCOUNTS } from '../payroll/payroll.constants';
import {
  AUTHORITY_ACCOUNT,
  DEFAULT_DUE_DAYS,
  accruedOnAccount,
  agingOf,
  cleanDueDays,
  dueDateFor,
  dueState,
  eobiTable,
  paymentJournalLines,
  paymentTotals,
  reminderDue,
  salaryTaxTable,
  statementsFromRun,
  statusFor,
  taxYearMonths,
} from './statutory.util';
import {
  StatutoryService,
  canApprove,
  canPrepare,
  canSeeFullIds,
  canView,
  type StatActor,
} from './statutory.service';
import {
  certificateTotals,
  renderSalaryCertificatePdf,
} from './certificate.pdf';

const owner: StatActor = { id: 'owner', isOwner: true, permissions: null };
const staff = (...p: string[]): StatActor => ({
  id: `s-${p.join('-') || 'none'}`,
  isOwner: false,
  permissions: new Set(p),
});

/** Two employees (tax, EOBI, one with PF) and a contractor with 10% withholding, shaped like payroll run lines. */
const RUN = {
  _id: 'run1',
  month: '2026-10',
  taxYear: '2026-27',
  status: 'approved',
  accrualJournalId: null as string | null,
  lines: [
    {
      adminId: 'a1',
      name: 'Ayesha',
      workerType: 'employee',
      taxableIncome: 150_000,
      gross: 150_000,
      net: 0,
      taxableIncomeNote: null,
      earnings: [{ kind: 'base', amount: 150_000 }],
      employer: [
        { kind: 'eobi', amount: 1850 },
        { kind: 'pf', amount: 7500 },
      ],
      deductions: [
        { kind: 'income_tax', amount: 4500 },
        { kind: 'eobi', amount: 370 },
        { kind: 'pf', amount: 7500 },
      ],
    },
    {
      adminId: 'a2',
      name: 'Bilal',
      workerType: 'employee',
      taxableIncome: 60_000,
      gross: 60_000,
      net: 0,
      earnings: [{ kind: 'base', amount: 60_000 }],
      employer: [{ kind: 'eobi', amount: 1850 }],
      deductions: [{ kind: 'eobi', amount: 370 }],
    },
    {
      adminId: 'c1',
      name: 'Contractor',
      workerType: 'contractor',
      taxableIncome: 0,
      gross: 42_000,
      net: 0,
      earnings: [
        { kind: 'incentive', amount: 40_000 },
        { kind: 'claim', amount: 2_000 },
      ],
      employer: [],
      deductions: [{ kind: 'withholding', amount: 4_000 }],
    },
    {
      adminId: 'x1',
      name: 'Excluded',
      excluded: true,
      workerType: 'employee',
      taxableIncome: 1,
      gross: 1,
      earnings: [],
      employer: [],
      deductions: [{ kind: 'income_tax', amount: 999 }],
    },
  ] as any[],
};
for (const l of RUN.lines)
  l.net = l.gross - l.deductions.reduce((s: number, d: any) => s + d.amount, 0);
const PROFILES = new Map([
  ['a1', { cnicLast4: '1234', ntnLast4: '5678', eobiNumber: 'EOBI-1' }],
]);

describe('statementsFromRun', () => {
  it('builds one statement per authority with per-person lines, leaving out excluded people and zero authorities', () => {
    const st = statementsFromRun(RUN as any, PROFILES, 37_000);
    const by = Object.fromEntries(st.map((s) => [s.authority, s]));
    expect(Object.keys(by).sort()).toEqual([
      'eobi',
      'fbr_salary',
      'fbr_withholding',
      'pf',
    ]);
    expect(by.fbr_salary.amount).toBe(4500);
    expect(by.fbr_salary.lines).toHaveLength(1);
    expect(by.fbr_salary.lines[0]).toMatchObject({
      adminId: 'a1',
      cnicLast4: '1234',
      taxableIncome: 150_000,
      amount: 4500,
    });
    expect(by.eobi.amount).toBe(4440);
    expect(
      by.eobi.lines.map((l) => [
        l.adminId,
        l.employeeShare,
        l.employerShare,
        l.wageBase,
      ]),
    ).toEqual([
      ['a1', 370, 1850, 37_000],
      ['a2', 370, 1850, 37_000],
    ]);
    expect(by.pf.amount).toBe(15_000);
    // Contractor withholding is on pay excluding claims.
    expect(by.fbr_withholding.lines[0]).toMatchObject({
      adminId: 'c1',
      taxableIncome: 40_000,
      amount: 4000,
    });
  });

  it('ties out to the payroll accrual journal on every liability account', () => {
    const people = RUN.lines
      .filter((l) => !l.excluded)
      .map((l) => ({ adminId: l.adminId, name: l.name, slip: l }));
    const journal = {
      lines: accrualLines(people as any, PAYROLL_ACCOUNTS) as any,
    };
    for (const st of statementsFromRun(RUN as any, PROFILES, 37_000)) {
      expect(accruedOnAccount(journal, AUTHORITY_ACCOUNT[st.authority])).toBe(
        st.amount,
      );
    }
  });
});

describe('due dates and reminders', () => {
  it('is the configured day of the following month, rolling over the year', () => {
    expect(
      dueDateFor('2026-12', 'eobi', DEFAULT_DUE_DAYS)
        .toISOString()
        .slice(0, 10),
    ).toBe('2027-01-15');
    expect(
      dueDateFor('2026-10', 'fbr_salary', {
        ...DEFAULT_DUE_DAYS,
        fbr_salary: 20,
      })
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-11-20');
  });

  it('ignores invalid due days', () => {
    expect(
      cleanDueDays({ eobi: 31, fbr_salary: 0, pf: 'x', fbr_withholding: 10 }),
    ).toEqual({ ...DEFAULT_DUE_DAYS, fbr_withholding: 10 });
  });

  it('classifies due soon (5 days) / overdue and sends each reminder once', () => {
    const due = new Date('2026-11-15T00:00:00Z');
    const s = (reminders: any = null) => ({
      status: 'pending' as const,
      dueDate: due,
      reminders,
    });
    expect(dueState(s(), new Date('2026-11-09T12:00:00Z'))).toBe('not_due');
    expect(dueState(s(), new Date('2026-11-10T08:00:00Z'))).toBe('due_soon');
    expect(dueState(s(), new Date('2026-11-15T23:00:00Z'))).toBe('due_soon');
    expect(dueState(s(), new Date('2026-11-16T00:00:00Z'))).toBe('overdue');
    expect(
      dueState({ status: 'paid', dueDate: due }, new Date('2027-01-01')),
    ).toBe('paid');
    expect(reminderDue(s(), new Date('2026-11-12'))).toBe('due_soon');
    expect(
      reminderDue(s({ dueSoonSentAt: new Date() }), new Date('2026-11-12')),
    ).toBeNull();
    expect(
      reminderDue(s({ dueSoonSentAt: new Date() }), new Date('2026-11-20')),
    ).toBe('overdue');
    expect(
      reminderDue(
        s({ dueSoonSentAt: new Date(), overdueSentAt: new Date() }),
        new Date('2026-11-20'),
      ),
    ).toBeNull();
  });

  it('ages overdue liabilities', () => {
    const due = new Date('2026-11-15T00:00:00Z');
    expect(agingOf(due, new Date('2026-11-15'))).toBe('not_due');
    expect(agingOf(due, new Date('2026-12-10'))).toBe('overdue_0_30');
    expect(agingOf(due, new Date('2027-01-05'))).toBe('overdue_31_60');
    expect(agingOf(due, new Date('2027-03-01'))).toBe('overdue_60_plus');
  });

  it('lists the 12 months of a July–June tax year', () => {
    const m = taxYearMonths('2026-27');
    expect(m[0]).toBe('2026-07');
    expect(m[11]).toBe('2027-06');
  });
});

describe('payments', () => {
  it('balances the journal, penalty included', () => {
    const lines = paymentJournalLines({
      liabilityAccount: '2220',
      bankAccount: '1010',
      amount: 4500,
      penalty: 120.5,
      label: 'x',
    });
    const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(dr).toBeCloseTo(cr, 2);
    expect(lines.find((l) => l.accountCode === '6910')?.debit).toBe(120.5);
    expect(lines.find((l) => l.accountCode === '1010')?.credit).toBe(4620.5);
  });

  it('tracks partial payments: pending, partially paid, paid', () => {
    const p = (
      status: 'submitted' | 'approved' | 'rejected',
      amount: number,
    ) => ({ status, amount });
    expect(statusFor(1000, [], 'pending')).toBe('pending');
    expect(statusFor(1000, [p('submitted', 400)], 'pending')).toBe('submitted');
    expect(statusFor(1000, [p('approved', 400)], 'pending')).toBe(
      'partially_paid',
    );
    expect(
      statusFor(1000, [p('approved', 400), p('rejected', 600)], 'pending'),
    ).toBe('partially_paid');
    expect(
      statusFor(1000, [p('approved', 400), p('approved', 600)], 'pending'),
    ).toBe('paid');
    expect(statusFor(1000, [], 'void')).toBe('void');
    expect(
      paymentTotals(1000, [p('approved', 400), p('submitted', 300)]),
    ).toMatchObject({
      paid: 400,
      pending: 300,
      remaining: 600,
      unclaimed: 300,
    });
  });
});

describe('filing working files', () => {
  it('salary tax statement has the columns needed for the Section 149 statement', () => {
    const t = salaryTaxTable(
      [
        {
          month: '2026-10',
          name: 'A',
          cnic: '3520112345671',
          ntn: '1234567',
          taxableIncome: 150000,
          employeeShare: 4500,
          employerShare: 0,
          amount: 4500,
          psid: 'P1',
          cpr: 'C1',
          paymentDate: '2026-11-10',
        },
      ],
      '2026-10',
    );
    expect(t.columns.map((c) => c.key)).toEqual([
      'month',
      'cnic',
      'name',
      'ntn',
      'taxableIncome',
      'amount',
      'psid',
      'cpr',
      'paymentDate',
    ]);
    expect(t.subtitle).toMatch(/WORKING FILE/);
    expect(t.rows.at(-1)).toMatchObject({
      amount: 4500,
      taxableIncome: 150000,
      _bold: 1,
    });
  });

  it('EOBI list carries EOBI number, wage base and both shares', () => {
    const t = eobiTable(
      [
        {
          month: '2026-10',
          name: 'A',
          cnic: '',
          ntn: '',
          eobiNumber: 'E1',
          wageBase: 37000,
          employeeShare: 370,
          employerShare: 1850,
          amount: 2220,
          psid: '',
          cpr: 'CH1',
          paymentDate: '2026-11-12',
        },
      ],
      '2026-10',
    );
    expect(t.columns.map((c) => c.key)).toEqual([
      'month',
      'name',
      'cnic',
      'eobiNumber',
      'wageBase',
      'employeeShare',
      'employerShare',
      'amount',
      'cpr',
      'paymentDate',
    ]);
    expect(t.rows.at(-1)).toMatchObject({
      employeeShare: 370,
      employerShare: 1850,
      amount: 2220,
    });
  });
});

describe('salary certificate', () => {
  it('totals the tax year and renders a PDF', async () => {
    const months = [
      {
        month: '2026-07',
        gross: 100000,
        taxable: 100000,
        tax: 2500,
        cpr: 'C1',
      },
      {
        month: '2026-08',
        gross: 100000.5,
        taxable: 100000.5,
        tax: 2500.25,
        cpr: '',
      },
    ];
    expect(certificateTotals(months)).toEqual({
      gross: 200000.5,
      taxable: 200000.5,
      tax: 5000.25,
    });
    const pdf = await renderSalaryCertificatePdf({
      taxYear: '2026-27',
      name: 'Ayesha',
      designation: 'Ops',
      cnic: '•••••1234',
      ntn: '',
      months,
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('permissions', () => {
  it('view / prepare / approve accept payroll OR accounting rights; full IDs need payroll.approve', () => {
    expect(canView(staff('accounting.view'))).toBe(true);
    expect(canView(staff('payroll.view'))).toBe(true);
    expect(canView(staff('orders.view'))).toBe(false);
    expect(canPrepare(staff('accounting.prepare'))).toBe(true);
    expect(canPrepare(staff('payroll.view'))).toBe(false);
    expect(canApprove(staff('accounting.approve'))).toBe(true);
    expect(canSeeFullIds(staff('accounting.approve'))).toBe(false);
    expect(canSeeFullIds(staff('payroll.approve'))).toBe(true);
    expect(canSeeFullIds(owner)).toBe(true);
  });
});

// ── Service with in-memory model mocks ─────────────────────────────────────
function makeService(
  opts: { existingRunIds?: string[]; statement?: any; settings?: any } = {},
) {
  const created: any[] = [];
  const posted: any[] = [];
  const logged: any[] = [];
  const statementDoc = opts.statement ?? null;
  const query = (doc: any) =>
    Object.assign(Promise.resolve(doc), {
      lean: async () => (doc ? JSON.parse(JSON.stringify(doc)) : null),
      select: () => query(doc),
    });
  const statements: any = {
    distinct: jest.fn(async () => opts.existingRunIds ?? []),
    create: jest.fn(async (d: any) => {
      if (
        created.some((c) => c.runId === d.runId && c.authority === d.authority)
      )
        throw Object.assign(new Error('dup'), { code: 11000 });
      created.push(d);
      return { ...d, _id: `st${created.length}` };
    }),
    findById: jest.fn(() => query(statementDoc)),
    find: jest.fn(() => ({
      select: () => ({
        lean: async () => (opts.statement ? [opts.statement] : []),
      }),
    })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  };
  const runs: any = {
    find: jest.fn(() => ({ select: () => ({ lean: async () => [RUN] }) })),
  };
  const profiles: any = {
    find: jest.fn(() => ({
      select: () => ({
        lean: async () => [
          {
            adminId: 'a1',
            cnicLast4: '1234',
            ntnLast4: null,
            eobiNumber: 'E1',
          },
        ],
      }),
    })),
  };
  const taxYears: any = {
    findOne: jest.fn(() => ({
      select: () => ({ lean: async () => ({ eobi: { minimumWage: 37000 } }) }),
    })),
  };
  const journals: any = {
    findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  };
  const settings: any = {
    findOne: jest.fn(() => ({
      select: () => ({ lean: async () => opts.settings ?? null }),
    })),
    updateOne: jest.fn(async () => ({})),
  };
  const ledger: any = {
    accountMap: jest.fn(
      async () =>
        new Map([
          [
            '1010',
            {
              code: '1010',
              name: 'Bank',
              type: 'asset',
              subtype: 'bank',
              isActive: true,
            },
          ],
          [
            '2220',
            {
              code: '2220',
              name: 'Tax',
              type: 'liability',
              subtype: 'tax_payable',
              isActive: true,
            },
          ],
        ]),
    ),
    isClosed: jest.fn(async () => false),
    postJournal: jest.fn(async (j: any) => {
      posted.push(j);
      return { entry: { _id: 'j1', number: 'JV-1' }, duplicate: false };
    }),
  };
  const db: any = {
    repositories: {
      adminModel: {
        find: () => ({ select: () => ({ lean: async () => [] }) }),
      },
    },
  };
  const activity: any = {
    log: jest.fn(async (x: any) => {
      logged.push(x);
      return true;
    }),
  };
  const upload: any = {};
  const svc = new StatutoryService(
    db,
    ledger,
    activity,
    upload,
    statements,
    runs,
    profiles,
    taxYears,
    journals,
    settings,
  );
  return { svc, statements, created, posted, logged, ledger };
}

describe('StatutoryService', () => {
  it('generates statements from an approved run once (idempotent per run + authority)', async () => {
    const { svc, created } = makeService();
    expect((await svc.generateFromRuns()).created).toBe(4);
    expect(created.map((c) => c.authority).sort()).toEqual([
      'eobi',
      'fbr_salary',
      'fbr_withholding',
      'pf',
    ]);
    expect(
      created
        .find((c) => c.authority === 'eobi')
        .dueDate.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-15');
    // A concurrent / repeated run hits the unique index and creates nothing more.
    expect((await svc.generateFromRuns()).created).toBe(0);
    const { svc: again } = makeService({ existingRunIds: ['run1'] });
    expect((await again.generateFromRuns()).created).toBe(0);
  });

  const statement = () => {
    const doc: any = {
      _id: 'st1',
      authority: 'fbr_salary',
      liabilityAccount: '2220',
      month: '2026-10',
      amount: 4500,
      status: 'pending',
      origin: 'payroll_run',
      dueDate: new Date('2026-11-15'),
      payments: [] as any[],
      history: [] as any[],
      lines: [],
      ledgerAccrued: 4500,
    };
    doc.save = jest.fn(async () => doc);
    doc.markModified = jest.fn();
    return doc;
  };

  it('records a partial payment, refuses overpaying, and needs another person to approve', async () => {
    const doc = statement();
    const { svc, posted } = makeService({ statement: doc });
    const preparer = staff('accounting.prepare');
    await svc.recordPayment(preparer, 'st1', {
      amount: 3000,
      paymentDate: '2026-11-10',
      cprNumber: 'CPR-1',
      psid: 'PSID-1',
      bankAccount: '1010',
    });
    expect(doc.payments).toHaveLength(1);
    expect(doc.status).toBe('submitted');
    await expect(
      svc.recordPayment(preparer, 'st1', {
        amount: 2000,
        paymentDate: '2026-11-10',
        cprNumber: 'CPR-2',
        bankAccount: '1010',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    doc.payments[0]._id = { toString: () => 'p1' };
    doc.payments[0].preparedBy = preparer.id;
    await expect(
      svc.approvePayment(
        {
          ...preparer,
          permissions: new Set(['accounting.prepare', 'accounting.approve']),
        },
        'st1',
        'p1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await svc.approvePayment(staff('payroll.approve'), 'st1', 'p1');
    expect(doc.status).toBe('partially_paid');
    expect(posted).toHaveLength(1);
    expect(posted[0].source).toEqual({
      type: 'statutory_payment',
      id: 'st1:p1',
      ref: 'PSID-1',
    });
    const dr = posted[0].lines.reduce(
      (s: number, l: any) => s + (l.debit ?? 0),
      0,
    );
    const cr = posted[0].lines.reduce(
      (s: number, l: any) => s + (l.credit ?? 0),
      0,
    );
    expect(dr).toBe(3000);
    expect(cr).toBe(3000);
  });

  it('blocks payments without prepare rights and full-ID exports without payroll.approve', async () => {
    const { svc } = makeService({ statement: statement() });
    await expect(
      svc.recordPayment(staff('accounting.view'), 'st1', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.filingTable(
        staff('accounting.approve'),
        'salary-tax',
        '2026-10',
        true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.filingTable(staff('orders.view'), 'salary-tax', '2026-10', false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sends each reminder once, only to the finance recipients, and not when turned off', async () => {
    const mail = sendMail as jest.Mock;
    mail.mockClear();
    const Svc = StatutoryService;
    const open = {
      _id: 'st1',
      authority: 'eobi',
      month: '2026-10',
      amount: 4440,
      payments: [],
      status: 'pending',
      dueDate: new Date('2026-11-15'),
      reminders: { dueSoonSentAt: null, overdueSentAt: null },
    };
    let claimed = false;
    const statements: any = {
      find: () => ({ select: () => ({ lean: async () => [open] }) }),
      updateOne: jest.fn(async () => {
        const first = !claimed;
        claimed = true;
        return { modifiedCount: first ? 1 : 0 };
      }),
    };
    const settingsOn: any = {
      findOne: () => ({
        select: () => ({
          lean: async () => ({
            statutoryRemindersEnabled: true,
            financePackRecipients: ['fin@example.com'],
          }),
        }),
      }),
    };
    const svc = new Svc(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      statements,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      settingsOn,
    );
    const now = new Date('2026-11-12T06:00:00Z');
    expect(await svc.sendReminders(now)).toEqual({ sent: 1, statements: 1 });
    expect(await svc.sendReminders(now)).toEqual({ sent: 0, statements: 0 });
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0].to).toBe('fin@example.com');
    const settingsOff: any = {
      findOne: () => ({
        select: () => ({
          lean: async () => ({
            statutoryRemindersEnabled: false,
            financePackRecipients: ['fin@example.com'],
          }),
        }),
      }),
    };
    const off = new Svc(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      statements,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      settingsOff,
    );
    expect(await off.sendReminders(now)).toEqual({ sent: 0, statements: 0 });
  });
});
