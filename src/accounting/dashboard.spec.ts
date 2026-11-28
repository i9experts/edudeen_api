/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- mock-heavy */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { permissionForRequest } from '../staff/permissions';
import type { AccountRow } from './accounting.util';
import {
  cleanRecipients, convertTotalsToPkr, expenseTotal, fiscalPeriodsUpTo, monthlySeries, packMonth, PAYROLL_EXPENSE_CODES, revenueMix,
} from './dashboard.util';
import { AccountingDashboardService, FINANCE_PACK_FILES } from './dashboard.service';

const row = (code: string, type: AccountRow['type'], subtype: string, debit: number, credit: number): AccountRow => ({ code, name: code, type, subtype, debit, credit });

describe('dashboard.util', () => {
  it('splits revenue into lines (credit - debit) with an Other bucket and a total', () => {
    const mix = revenueMix([
      row('4000', 'income', 'revenue', 10, 1010), // self commission 1000 net
      row('4010', 'income', 'revenue', 0, 2500), // MOU commission
      row('4100', 'income', 'revenue', 0, 300),
      row('4900', 'income', 'other_income', 50, 0), // FX loss -> Other -50
      row('6000', 'expense', 'payroll', 999, 0), // not income
    ]);
    const by = Object.fromEntries(mix.lines.map((l) => [l.key, l.amount]));
    expect(by.commission_self).toBe(1000);
    expect(by.commission_mou).toBe(2500);
    expect(by.subscriptions).toBe(300);
    expect(by.premium).toBe(0);
    expect(by.other).toBe(-50);
    expect(mix.total).toBe(3750);
  });

  it('payroll cost = net debits of payroll expense accounts only', () => {
    const rows = [row('6000', 'expense', 'payroll', 100000, 0), row('6020', 'expense', 'payroll', 25000, 5000), row('6100', 'expense', 'opex', 7000, 0)];
    expect(expenseTotal(rows, PAYROLL_EXPENSE_CODES)).toBe(120000);
  });

  it('fiscal periods run July..current month, max 12', () => {
    expect(fiscalPeriodsUpTo(new Date(Date.UTC(2026, 6, 1)), '2026-09')).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(fiscalPeriodsUpTo(new Date(Date.UTC(2026, 6, 1)), '2027-02')).toHaveLength(8);
    expect(fiscalPeriodsUpTo(new Date(Date.UTC(2026, 6, 1)), '2030-01')).toHaveLength(12);
  });

  it('monthly series: income/expenses per month and a running cash balance, empty months carried forward', () => {
    const s = monthlySeries(['2026-07', '2026-08', '2026-09'], [
      { period: '2026-07', code: '4000', type: 'income', subtype: 'revenue', debit: 0, credit: 500 },
      { period: '2026-07', code: '1010', type: 'asset', subtype: 'bank', debit: 500, credit: 0 },
      { period: '2026-09', code: '6300', type: 'expense', subtype: 'opex', debit: 200, credit: 0 },
      { period: '2026-09', code: '1010', type: 'asset', subtype: 'bank', debit: 0, credit: 200 },
      { period: '2026-09', code: '1110', type: 'asset', subtype: 'receivable', debit: 40, credit: 0 }, // COD with couriers counts as cash-like
      { period: '2026-09', code: '1200', type: 'asset', subtype: 'receivable', debit: 999, credit: 0 }, // plain receivable does not
    ], 1000);
    expect(s).toEqual([
      { period: '2026-07', income: 500, expenses: 0, net: 500, cash: 1500 },
      { period: '2026-08', income: 0, expenses: 0, net: 0, cash: 1500 },
      { period: '2026-09', income: 0, expenses: 200, net: -200, cash: 1340 },
    ]);
  });

  it('converts order totals to PKR with ratePerUSD and reports currencies it cannot convert', () => {
    const r = convertTotalsToPkr([
      { currency: 'PKR', total: 10000, count: 3 },
      { currency: 'USD', total: 10, count: 1 },
      { currency: 'AED', total: 36.7, count: 1 },
      { currency: 'XYZ', total: 5, count: 1 },
    ], { PKR: 280, AED: 3.67 });
    expect(r.pkr).toBe(10000 + 2800 + 2800);
    expect(r.orders).toBe(6);
    expect(r.unconverted).toEqual(['XYZ']);
  });

  it('pack month defaults to last month and accepts YYYY-MM', () => {
    const d = packMonth(undefined, new Date(Date.UTC(2026, 10, 3)));
    expect(d.month).toBe('2026-10');
    expect(d.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(d.to.toISOString()).toBe('2026-10-31T23:59:59.999Z');
    expect(packMonth('2027-02').to.toISOString()).toBe('2027-02-28T23:59:59.999Z');
    expect(packMonth('2026-13', new Date(Date.UTC(2027, 0, 9))).month).toBe('2026-12');
  });

  it('cleans finance-pack recipients', () => {
    expect(cleanRecipients(' A@x.com, b@y.org;a@x.com bad-address ')).toEqual(['a@x.com', 'b@y.org']);
    expect(cleanRecipients(Array.from({ length: 15 }, (_, i) => `p${i}@x.com`))).toHaveLength(10);
    expect(cleanRecipients(null)).toEqual([]);
  });
});

describe('AccountingDashboardService', () => {
  const owner = { id: 'o', isOwner: true, permissions: null };
  const staff = (...perms: string[]) => ({ id: 's', isOwner: false, permissions: new Set(perms) });

  function make(over: Partial<Record<string, any>> = {}) {
    const table = jest.fn(async (name: string, q: any) => ({ title: name, subtitle: JSON.stringify(q), columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] }));
    const reports: any = { table, accountTotals: jest.fn(async () => []) };
    const journals: any = { aggregate: jest.fn(async () => []), countDocuments: jest.fn(async () => 2), find: jest.fn(() => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) })) };
    const settingsStore: any = { doc: null };
    const settings: any = {
      findOne: jest.fn(() => ({ lean: async () => settingsStore.doc })),
      updateOne: jest.fn(async (_f: any, u: any) => { settingsStore.doc = { ...(settingsStore.doc ?? {}), ...u.$set }; return { modifiedCount: 1 }; }),
    };
    const runs: any = { find: jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'r1', month: '2026-10', totals: { net: 5, people: 1 } }] }) })) };
    const advances: any = { countDocuments: jest.fn(async () => 1) };
    const claims: any = { countDocuments: jest.fn(async () => 4) };
    const activity: any = { log: jest.fn(async () => true) };
    const svc = new AccountingDashboardService({ repositories: {} } as any, reports, {} as any, activity, journals, settings, runs, advances, claims, {} as any);
    Object.assign(svc, over);
    return { svc, table, journals, settings, settingsStore, runs, activity };
  }

  it('finance pack contains every statement for the month, with month-bounded ranges', async () => {
    const { svc, table } = make();
    jest.spyOn(svc, 'generalLedgerAll').mockResolvedValue({ title: 'GL', subtitle: '', columns: [], rows: [] });
    const { month, tables } = await svc.financePackTables('2026-09');
    expect(month).toBe('2026-09');
    expect(tables.map((t) => t.file)).toEqual([...FINANCE_PACK_FILES]);
    expect(table).toHaveBeenCalledWith('profit-loss', { from: '2026-09-01', to: '2026-09-30' });
    expect(table).toHaveBeenCalledWith('balance-sheet', { asOf: '2026-09-30' });
    expect(table).toHaveBeenCalledWith('trial-balance', { asOf: '2026-09-30' });
    expect(table).toHaveBeenCalledWith('party-ledger', { partyType: 'seller', from: '2026-09-01', to: '2026-09-30' });
    expect(table).toHaveBeenCalledWith('payouts', { from: '2026-09-01', to: '2026-09-30' });
  });

  it('finance pack is a zip and the download is logged', async () => {
    const { svc, activity } = make();
    jest.spyOn(svc, 'generalLedgerAll').mockResolvedValue({ title: 'GL', subtitle: '', columns: [{ key: 'a', label: 'A' }], rows: [] });
    const { body, fileName } = await svc.financePack(owner, '2026-09');
    expect(fileName).toBe('edudeen-finance-pack-2026-09.zip');
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'finance_pack_downloaded' }));
  });

  it('refuses a month that has not started', async () => {
    const { svc } = make();
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 2);
    await expect(svc.financePackTables(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only an accounting approver changes the finance-pack e-mail, and needs recipients to turn it on', async () => {
    const { svc } = make();
    await expect(svc.saveSettings(staff('accounting.view', 'accounting.prepare'), { financePackEmailEnabled: true, financePackRecipients: ['f@x.com'] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.saveSettings(owner, { financePackEmailEnabled: true, financePackRecipients: [] })).rejects.toBeInstanceOf(BadRequestException);
    const saved = await svc.saveSettings(staff('accounting.approve'), { financePackEmailEnabled: true, financePackRecipients: 'f@x.com' });
    expect(saved).toEqual(expect.objectContaining({ financePackEmailEnabled: true, financePackRecipients: ['f@x.com'] }));
  });

  it('monthly notice does nothing while turned off', async () => {
    const { svc } = make();
    expect(await svc.sendMonthlyNotice(new Date(Date.UTC(2026, 10, 3)))).toEqual({ sent: 0, month: null });
  });

  it('payroll queue items are only included for people with a payroll right', async () => {
    const { svc } = make();
    const books = await (svc as any).approvals(false);
    expect(books.journals.count).toBe(2);
    expect(books.payrollRuns).toBeUndefined();
    const full = await (svc as any).approvals(true);
    expect(full.payrollRuns).toEqual([{ id: 'r1', month: '2026-10', net: 5, people: 1 }]);
    expect(full.claims).toBe(4);
  });

  it('staff route rules: dashboard/pack need accounting.view; settings changes need accounting.approve', () => {
    expect(permissionForRequest('GET', '/api/admin/accounting/dashboard')).toBe('accounting.view');
    expect(permissionForRequest('GET', '/api/admin/accounting/finance-pack')).toBe('accounting.view');
    expect(permissionForRequest('GET', '/api/admin/accounting/settings')).toBe('accounting.view');
    expect(permissionForRequest('PUT', '/api/admin/accounting/settings')).toBe('accounting.approve');
  });
});
