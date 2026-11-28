/* eslint-disable prettier/prettier, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- mock-heavy test */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SEED_ACCOUNTS, POSTING_ACCOUNTS as A } from './accounting.constants';
import {
  ageBalance, balanceSheet, convertToBase, depreciationMonthIndex, fiscalYearOf, monthlyDepreciation, normaliseLines, periodOf,
  profitAndLoss, round2, trialBalance, type AccountRow,
} from './accounting.util';
import {
  convertDraftLines, postAddon, postPayoutCompleted, postPlanInvoice, postPlanRefund, postPremiumPayment, postSellerTx,
  type PostingDraft, type SellerTxInput,
} from './posting/posting.rules';
import { AccountingService } from './accounting.service';
import { toCsv, toXlsx, toPdf } from './export.util';

const D = (s: string) => new Date(`${s}T10:00:00Z`);
const sum = (lines: any[], k: 'debit' | 'credit') => round2(lines.reduce((s, l) => s + (l[k] ?? 0), 0));
const post = (r: any): PostingDraft => { if (!('post' in r)) throw new Error(`expected a journal, got skip: ${r.skip}`); return r.post; };
const tx = (over: Partial<SellerTxInput>): SellerTxInput => ({
  _id: 't1', storeId: 's1', type: 'sale', amount: 100, currency: 'USD', status: 'completed', referenceId: 'o1', referenceType: 'order', metadata: {}, createdAt: D('2026-08-05'), ...over,
});

describe('accounting utils', () => {
  it('rounds half-up to the paisa', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('enforces debit = credit and one side per line', () => {
    expect(() => normaliseLines([{ accountCode: '1010', debit: 10 }, { accountCode: '4000', credit: 9.99 }])).toThrow(/must be equal/);
    expect(() => normaliseLines([{ accountCode: '1010', debit: 10, credit: 10 }, { accountCode: '4000', credit: 10 }])).toThrow(/either a debit or a credit/);
    expect(() => normaliseLines([{ accountCode: '1010', debit: 10 }])).toThrow(/at least two lines/);
    expect(() => normaliseLines([{ accountCode: '1010', debit: -5 }, { accountCode: '4000', credit: -5 }])).toThrow(/negative/);
    const ok = normaliseLines([{ accountCode: '1010', debit: 0.1 }, { accountCode: '1010', debit: 0.2 }, { accountCode: '4000', credit: 0.3 }]);
    expect(ok).toHaveLength(3);
    expect(ok[0].currency).toBe('PKR');
  });

  it('knows the July-June fiscal year and periods', () => {
    expect(fiscalYearOf(D('2026-07-01'))).toBe('2026-27');
    expect(fiscalYearOf(D('2027-06-30'))).toBe('2026-27');
    expect(fiscalYearOf(D('2027-07-01'))).toBe('2027-28');
    expect(fiscalYearOf(D('2026-06-30'))).toBe('2025-26');
    expect(periodOf(D('2026-09-15'))).toBe('2026-09');
  });

  it('converts USD to PKR with rates per USD', () => {
    expect(convertToBase(10, 'USD', { PKR: 280.5 })).toEqual({ amount: 2805, fxRate: 280.5 });
    expect(convertToBase(10, 'PKR', {})).toEqual({ amount: 10, fxRate: 1 });
    expect(() => convertToBase(10, 'EUR', { PKR: 280 })).toThrow(/No EUR\/PKR/);
  });
});

describe('posting rules', () => {
  it('card sale: buyer payment into Stripe clearing, gross (incl. shipping) owed to the seller', () => {
    const p = post(postSellerTx(tx({ amount: 100, metadata: { shippingCredit: 5, feeRateSource: 'global' } }), { paymentMethodType: 'stripe', customer: { id: 'u1', name: 'Ali' }, orderNumber: 'ED-1' }));
    expect(p.lines).toEqual([
      expect.objectContaining({ accountCode: A.stripeClearing, debit: 105, party: { type: 'customer', id: 'u1', name: 'Ali' } }),
      expect.objectContaining({ accountCode: A.sellerPayable, credit: 105, party: expect.objectContaining({ type: 'seller', id: 's1' }) }),
    ]);
    expect(p.ref).toBe('Order #ED-1');
    expect(p.currency).toBe('USD');
  });

  it('fee: self-managed commission vs managed MOU commission, card processing separately', () => {
    const self = post(postSellerTx(tx({ type: 'fee', amount: -11.3, metadata: { platformFee: 8, processingFee: 3.3 } }), { saleMeta: { feeRateSource: 'global' } }));
    expect(self.lines.find((l) => l.accountCode === A.commissionSelf)?.credit).toBe(8);
    expect(self.lines.find((l) => l.accountCode === A.processingFeeIncome)?.credit).toBe(3.3);
    expect(sum(self.lines, 'debit')).toBe(sum(self.lines, 'credit'));

    const managed = post(postSellerTx(tx({ type: 'fee', amount: -30, metadata: { platformFee: 30, processingFee: 0 } }), { saleMeta: { feeRateSource: 'managed_mou' } }));
    expect(managed.lines).toEqual([
      expect.objectContaining({ accountCode: A.sellerPayable, debit: 30 }),
      expect.objectContaining({ accountCode: A.commissionManaged, credit: 30 }),
    ]);
    // No fee rule recorded: fall back to the store's current type.
    const fallback = post(postSellerTx(tx({ type: 'fee', amount: -20, metadata: { platformFee: 20 } }), { managementType: 'managed' }));
    expect(fallback.lines[1].accountCode).toBe(A.commissionManaged);
  });

  it('cash kept by the seller is not a sale for Edudeen; its subsidy goes to the seller balance', () => {
    expect(postSellerTx(tx({ metadata: { collectedBy: 'seller' } }))).toEqual({ skip: expect.stringContaining('cash collected by seller') });
    const sub = post(postSellerTx(tx({ type: 'platform_subsidy', amount: 4, metadata: { creditedToWallet: true } })));
    expect(sub.lines.map((l) => l.accountCode)).toEqual([A.subsidyExpense, A.sellerPayable]);
    const normal = post(postSellerTx(tx({ type: 'platform_subsidy', amount: 4, metadata: {} }), { paymentMethodType: 'cash_on_delivery' }));
    expect(normal.lines.map((l) => l.accountCode)).toEqual([A.subsidyExpense, A.codReceivable]);
  });

  it('refund, payout request, rejected payout and manual adjustments', () => {
    const refund = post(postSellerTx(tx({ type: 'refund', amount: -50 }), { paymentMethodType: 'stripe', customer: { id: 'u1' } }));
    expect(refund.lines).toEqual([expect.objectContaining({ accountCode: A.sellerPayable, debit: 50 }), expect.objectContaining({ accountCode: A.stripeClearing, credit: 50 })]);
    expect(postSellerTx(tx({ type: 'refund', amount: -50, metadata: { collectedBy: 'seller', walletDebit: 0 } }))).toHaveProperty('skip');

    const payout = post(postSellerTx(tx({ type: 'payout', amount: -200, referenceType: 'payout' })));
    expect(payout.lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0])).toEqual([[A.sellerPayable, 200, 0], [A.payoutsInTransit, 0, 200]]);
    const rejected = post(postSellerTx(tx({ type: 'adjustment', amount: 200, referenceType: 'payout', metadata: { rejectedBy: 'a1' } })));
    expect(rejected.lines.map((l) => l.accountCode)).toEqual([A.payoutsInTransit, A.sellerPayable]);

    expect(postSellerTx(tx({ type: 'adjustment', amount: 5, metadata: { shippingCredit: true } }))).toHaveProperty('skip');
    const reversal = post(postSellerTx(tx({ type: 'adjustment', amount: 3, metadata: { codCommissionReversal: true } }), { saleMeta: { feeRateSource: 'managed_mou' } }));
    expect(reversal.lines[0]).toEqual(expect.objectContaining({ accountCode: A.commissionManaged, debit: 3 }));
    const goodwill = post(postSellerTx(tx({ type: 'adjustment', amount: -7, referenceType: 'manual' })));
    expect(goodwill.lines).toEqual([expect.objectContaining({ accountCode: A.sellerPayable, debit: 7 }), expect.objectContaining({ accountCode: A.sellerAdjustments, credit: 7 })]);
    expect(postSellerTx(tx({ status: 'failed' }))).toHaveProperty('skip');
  });

  it('payout paid, plan invoice + refund delta, add-on, Premium payment', () => {
    const paid = post(postPayoutCompleted({ _id: 'p1', storeId: 's1', amount: 200, currency: 'PKR', status: 'completed', processedAt: D('2026-08-10') }, 'Store'));
    expect(paid.lines.map((l) => l.accountCode)).toEqual([A.payoutsInTransit, A.bank]);
    expect(postPayoutCompleted({ _id: 'p1', storeId: 's1', amount: 200, currency: 'PKR', status: 'processing' })).toHaveProperty('skip');

    const inv = { _id: 'i1', storeId: 's1', invoiceNumber: 'PP-1', amountUSD: 29, status: 'partially_refunded', paidAt: D('2026-08-01'), refundedAt: D('2026-08-20'), refundedAmountUSD: 10, paymentMethodType: 'card' };
    expect(post(postPlanInvoice(inv)).lines).toEqual([expect.objectContaining({ accountCode: A.stripeClearing, debit: 29 }), expect.objectContaining({ accountCode: A.platformPlanIncome, credit: 29 })]);
    expect(post(postPlanRefund(inv, 0)).lines[0]).toEqual(expect.objectContaining({ accountCode: A.platformPlanIncome, debit: 10 }));
    expect(post(postPlanRefund({ ...inv, refundedAmountUSD: 29 }, 10)).lines[0].debit).toBe(19);
    expect(postPlanRefund(inv, 10)).toHaveProperty('skip');

    expect(post(postAddon({ _id: 'a1', storeId: 's1', addonType: 'extra_ai_credits', priceUSD: 15, providerChargeId: 'ch_1', createdAt: D('2026-08-02') })).lines[1].accountCode).toBe(A.addonIncome);
    expect(postAddon({ _id: 'a1', storeId: 's1', addonType: 'x', priceUSD: 15, providerChargeId: null, createdAt: D('2026-08-02') })).toHaveProperty('skip');

    const prem = post(postPremiumPayment({ _id: 'pp', userId: 'u1', interval: 'monthly', amountUSD: 5, amountPKR: 1400, status: 'approved', reviewedAt: D('2026-08-03') }));
    expect(prem.currency).toBe('PKR');
    expect(prem.lines).toEqual([expect.objectContaining({ accountCode: A.bank, debit: 1400 }), expect.objectContaining({ accountCode: A.premiumIncome, credit: 1400 })]);
  });

  it('converts a USD draft to PKR and still balances to the paisa', () => {
    const draft: PostingDraft = { date: D('2026-08-05'), currency: 'USD', memo: 'x', ref: null, lines: [
      { accountCode: A.sellerPayable, debit: 10.01 }, { accountCode: A.commissionSelf, credit: 3.33 }, { accountCode: A.processingFeeIncome, credit: 3.34 }, { accountCode: A.processingFeeIncome, credit: 3.34 },
    ] };
    const lines = convertDraftLines(draft, 278.123);
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    expect(lines[0]).toEqual(expect.objectContaining({ currency: 'USD', amountOriginal: 10.01, fxRate: 278.123 }));
    expect(() => normaliseLines(lines)).not.toThrow();
  });

  it('every account a rule can use is in the seeded chart', () => {
    const codes = new Set(SEED_ACCOUNTS.map((a) => a.code));
    for (const c of Object.values(A)) expect(codes.has(c)).toBe(true);
  });
});

describe('depreciation and aging', () => {
  it('straight line: equal months, last month absorbs rounding, total = cost - salvage', () => {
    const asset = { cost: 100_000, salvage: 10_000, usefulLifeMonths: 7, purchaseDate: D('2026-06-15') };
    const months = Array.from({ length: 9 }, (_, i) => monthlyDepreciation(asset, i));
    expect(months.slice(0, 6).every((m) => m === 12857.14)).toBe(true);
    expect(months[6]).toBe(12857.16);
    expect(months[7]).toBe(0);
    expect(round2(months.reduce((s, m) => s + m, 0))).toBe(90_000);
    expect(depreciationMonthIndex(asset.purchaseDate, '2026-07')).toBe(0);
    expect(depreciationMonthIndex(asset.purchaseDate, '2026-06')).toBe(-1);
  });

  it('ages an open balance FIFO into 0-30 / 31-60 / 61-90 / 90+ buckets', () => {
    const asOf = D('2026-12-31');
    const res = ageBalance([
      { date: D('2026-08-01'), increase: 100, decrease: 0 }, // 152 days
      { date: D('2026-10-15'), increase: 50, decrease: 0 }, // 77 days
      { date: D('2026-12-20'), increase: 30, decrease: 0 }, // 11 days
      { date: D('2026-12-25'), increase: 0, decrease: 120 }, // pays all of Aug + 20 of Oct
    ], asOf);
    expect(res).toEqual({ current: 30, d31_60: 0, d61_90: 30, over90: 0, total: 60 });
    const over = ageBalance([{ date: D('2026-12-01'), increase: 10, decrease: 0 }, { date: D('2026-12-02'), increase: 0, decrease: 15 }], asOf);
    expect(over.total).toBe(-5);
  });
});

describe('statements', () => {
  // Opening capital 500k in the bank; a card sale (USD converted) of 28,000 incl. commission 2,800; payout 10,000; rent 20,000.
  const journals = [
    [['1010', 500_000, 0], ['3000', 0, 500_000]],
    [['1100', 28_000, 0], ['2000', 0, 28_000]],
    [['2000', 2_800, 0], ['4000', 0, 2_800]],
    [['2000', 10_000, 0], ['2010', 0, 10_000]],
    [['2010', 10_000, 0], ['1010', 0, 10_000]],
    [['6300', 20_000, 0], ['1010', 0, 20_000]],
  ] as const;
  const totals = (): AccountRow[] => {
    const m = new Map<string, { debit: number; credit: number }>();
    for (const j of journals) for (const [code, d, c] of j) { const cur = m.get(code) ?? { debit: 0, credit: 0 }; cur.debit += d; cur.credit += c; m.set(code, cur); }
    const acc = new Map(SEED_ACCOUNTS.map((a) => [a.code, a]));
    return [...m.entries()].map(([code, v]) => ({ code, name: acc.get(code)!.name, type: acc.get(code)!.type, subtype: acc.get(code)!.subtype, ...v }));
  };

  it('trial balance balances', () => {
    const tb = trialBalance(totals());
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('P&L and balance sheet: assets = liabilities + equity including current year earnings', () => {
    const rows = totals();
    const pl = profitAndLoss(rows);
    expect(pl).toEqual(expect.objectContaining({ totalIncome: 2_800, totalExpenses: 20_000, netProfit: -17_200 }));
    const bs = balanceSheet(rows, 0, pl.netProfit);
    expect(bs.totalAssets).toBe(498_000); // bank 470,000 + Stripe clearing 28,000
    expect(bs.totalLiabilities).toBe(15_200); // seller payables 28,000 - 2,800 - 10,000
    expect(bs.totalEquity).toBe(482_800); // capital 500,000 - loss 17,200
    expect(bs.balanced).toBe(true);
    expect(bs.equity.find((e) => e.subtype === 'current_earnings')?.amount).toBe(-17_200);
    // Prior-year profit moves into retained earnings.
    const bs2 = balanceSheet(rows.filter((r) => r.type !== 'income' && r.type !== 'expense'), pl.netProfit, 0);
    expect(bs2.equity.find((e) => e.subtype === 'retained_earnings')?.amount).toBe(-17_200);
    expect(bs2.balanced).toBe(true);
  });
});

describe('AccountingService ledger rules (mocked models)', () => {
  const leanQ = (v: any) => ({ lean: async () => v, select: () => ({ lean: async () => v }), sort: () => ({ lean: async () => v }) });
  function make(opts: { closed?: string[]; existing?: any } = {}) {
    const created: any[] = [];
    const accounts = { find: () => ({ select: () => ({ lean: async () => SEED_ACCOUNTS.map((a) => ({ ...a, isActive: true })) }) }) };
    const journals: any = {
      findOne: () => leanQ(opts.existing ?? null),
      findById: (id: string) => leanQ(journals._byId?.[id] ?? null),
      create: async (doc: any) => { created.push(doc); return { ...doc, toObject: () => ({ ...doc, _id: 'new' }) }; },
      exists: async () => null,
      findOneAndUpdate: (_f: any, u: any) => ({ lean: async () => ({ ...(journals._byId?.j1 ?? {}), ...u.$set }) }),
      updateOne: async () => ({}),
    };
    const periods = { exists: async (q: any) => (opts.closed ?? []).includes(q.period) };
    const counters = { findOneAndUpdate: () => ({ lean: async () => ({ seq: 7 }) }) };
    const activity = { log: async () => true };
    const svc = new AccountingService(accounts as any, journals, periods as any, {} as any, {} as any, counters as any, activity as any);
    return { svc, created, journals };
  }
  const lines = [{ accountCode: '6300', debit: 1000 }, { accountCode: '1010', credit: 1000 }];

  it('posts a balanced journal with a fiscal-year number', async () => {
    const { svc, created } = make();
    const { entry, duplicate } = await svc.postJournal({ date: D('2026-08-10'), memo: 'Rent', lines, kind: 'manual' });
    expect(duplicate).toBe(false);
    expect(entry.number).toBe('JV-2026-27-000007');
    expect(created[0]).toEqual(expect.objectContaining({ status: 'posted', period: '2026-08', fiscalYear: '2026-27', total: 1000 }));
  });

  it('rejects unbalanced lines and unknown accounts', async () => {
    const { svc } = make();
    await expect(svc.postJournal({ date: D('2026-08-10'), memo: '', lines: [{ accountCode: '6300', debit: 10 }, { accountCode: '1010', credit: 9 }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.postJournal({ date: D('2026-08-10'), memo: '', lines: [{ accountCode: '9999', debit: 10 }, { accountCode: '1010', credit: 10 }] })).rejects.toThrow(/Unknown account/);
    await expect(svc.postJournal({ date: D('2026-08-10'), memo: '', lines: [{ accountCode: '3200', debit: 10 }, { accountCode: '1010', credit: 10 }] })).rejects.toThrow(/Current year earnings/);
  });

  it('refuses manual posting into a closed month; moves auto postings to the next open month with a flag', async () => {
    const { svc, created } = make({ closed: ['2026-08'] });
    await expect(svc.postJournal({ date: D('2026-08-10'), memo: '', lines, kind: 'manual' })).rejects.toThrow(/2026-08 is closed/);
    const { entry } = await svc.postJournal({ date: D('2026-08-10'), memo: '', lines, kind: 'auto', source: { type: 'seller_tx', id: 'x' } });
    expect(entry.period).toBe('2026-09');
    expect(created[0].flags[0]).toMatch(/2026-08 was closed/);
  });

  it('is idempotent per source', async () => {
    const existing = { _id: 'old', number: 'JV-2026-27-000001', source: { type: 'seller_tx', id: 't1' } };
    const { svc, created } = make({ existing });
    const res = await svc.postJournal({ date: D('2026-08-10'), memo: '', lines, kind: 'auto', source: { type: 'seller_tx', id: 't1' } });
    expect(res).toEqual({ entry: existing, duplicate: true });
    expect(created).toHaveLength(0);
  });

  it('approver must differ from the preparer (owner exempt) and needs accounting.approve', async () => {
    const { svc, journals } = make();
    journals._byId = { j1: { _id: 'j1', status: 'submitted', preparedBy: 'staff1', period: '2026-08', fiscalYear: '2026-27', kind: 'manual', lines } };
    const staff = (id: string, perms: string[]) => ({ id, isOwner: false, permissions: new Set(perms) });
    await expect(svc.approve(staff('staff2', ['accounting.view']), 'j1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.approve(staff('staff1', ['accounting.approve']), 'j1')).rejects.toThrow(/someone else must approve/);
    const ok = await svc.approve(staff('staff2', ['accounting.approve']), 'j1');
    expect(ok).toEqual(expect.objectContaining({ status: 'posted', approvedBy: 'staff2', number: 'JV-2026-27-000007' }));
    const owner = await svc.approve({ id: 'staff1', isOwner: true, permissions: null }, 'j1');
    expect(owner.status).toBe('posted');
  });
});

describe('exports', () => {
  const table = { title: 'Trial balance', subtitle: 'As of 2026-08-31', columns: [{ key: 'name', label: 'Account' }, { key: 'debit', label: 'Debit', align: 'right' as const }], rows: [{ name: '=cmd()', debit: 1234.5 }, { name: 'Total', debit: 1234.5, _bold: 1 }] };
  it('CSV neutralises formula injection and keeps numbers numeric', () => {
    const csv = toCsv(table).toString('utf8');
    expect(csv).toContain("'=cmd()");
    expect(csv).toContain('1234.5');
  });
  it('XLSX is a zip, PDF is a PDF', async () => {
    const x = await toXlsx(table);
    expect(x.subarray(0, 2).toString()).toBe('PK');
    const p = await toPdf(table);
    expect(p.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
