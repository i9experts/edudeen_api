/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { buildStatementLines, nextPayoutDate, resolveNextPayout, statementCsv, earliestRelease, type LedgerTx } from './seller-earnings.util';

const SELLER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439022';
const STORE = '507f1f77bcf86cd799439033';

const chain = (result: any) => {
  const c: any = {};
  for (const k of ['sort', 'skip', 'limit', 'select']) c[k] = jest.fn().mockReturnValue(c);
  c.lean = jest.fn().mockResolvedValue(result);
  c.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
  c.catch = (rej: any) => Promise.resolve(result).catch(rej);
  return c;
};
const one = (v: any) => ({ lean: jest.fn().mockResolvedValue(v), select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }) });

const tx = (over: Partial<LedgerTx>): LedgerTx => ({ type: 'sale', amount: 0, status: 'completed', referenceId: 'o1', referenceType: 'order', createdAt: '2026-10-05T10:00:00Z', metadata: {}, ...over });

describe('seller earnings util', () => {
  it('monthly schedule: month M earnings -> the 1st of M+1, and nothing payable -> no date', () => {
    const from = new Date(2026, 9, 20, 12); // 20 Oct (local)
    const next = nextPayoutDate({ frequency: 'monthly', dayOfMonth: 1 }, from)!;
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 10, 1]);
    expect(resolveNextPayout({ frequency: 'monthly', dayOfMonth: 1 }, 0, from)).toBeNull();
    expect(resolveNextPayout({ frequency: 'monthly', dayOfMonth: 1 }, -5, from)).toBeNull();
    expect(resolveNextPayout({ frequency: 'manual' }, 100, from)).toBeNull();
  });

  it('when nothing is available yet the date moves past the earliest clearing release', () => {
    const from = new Date(2026, 10, 25, 12); // 25 Nov: a sale clears on 9 Dec, so Dec 1 is too early
    const release = earliestRelease([{ createdAt: new Date(2026, 10, 25), metadata: { clearingDays: 14 } }])!;
    const next = resolveNextPayout({ frequency: 'monthly', dayOfMonth: 1 }, 50, from, release)!;
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2027, 0, 1]);
  });

  it('statement rows add up to the month net (sale, COD commission debit, refund, platform subsidy)', () => {
    const txs: LedgerTx[] = [
      tx({ referenceId: 'o1', type: 'sale', amount: 1000, status: 'pending', metadata: { clearingDays: 14 } }),
      tx({ referenceId: 'o1', type: 'fee', amount: -130, metadata: { platformFee: 100, processingFee: 30 } }),
      tx({ referenceId: 'o2', type: 'fee', amount: -50, metadata: { codCommission: true, platformFee: 50, processingFee: 0 } }),
      tx({ referenceId: 'o3', type: 'sale', amount: 400 }),
      tx({ referenceId: 'o3', type: 'fee', amount: -40, metadata: { platformFee: 40, processingFee: 0 } }),
      tx({ referenceId: 'o3', type: 'refund', amount: -400 }),
      tx({ referenceId: 'o1', type: 'adjustment', amount: 80, metadata: { shippingCredit: true } }), // informational only
      tx({ referenceId: 'o4', type: 'sale', amount: 200, status: 'failed' }),                           // ignored
    ];
    const { lines, totals } = buildStatementLines(txs);
    expect(lines).toHaveLength(3);
    const byOrder = Object.fromEntries(lines.map((l) => [l.orderId, l]));
    expect(byOrder.o1.net).toBe(870);                       // 1000 - 100 - 30
    expect(byOrder.o1.status).toBe('clearing');
    expect(byOrder.o2.net).toBe(-50);                       // seller kept the cash: only the commission is debited
    expect(byOrder.o2.status).toBe('cod_debit');
    expect(byOrder.o3.net).toBe(-40);                       // 400 - 40 - 400
    expect(totals.net).toBe(lines.reduce((s, l) => s + l.net, 0));
    expect(totals.net).toBe(780);
    expect(totals.gross).toBe(1400);
    expect(totals.platformFee).toBe(190);
    expect(totals.processingFee).toBe(30);
    expect(totals.refunds).toBe(400);
    expect(totals.orderCount).toBe(3);
  });

  it('CSV totals equal the screen totals, cells are formula-safe, and a capped month says TRUNCATED', () => {
    const { lines, totals } = buildStatementLines([
      tx({ referenceId: 'o1', type: 'sale', amount: 1000 }),
      tx({ referenceId: 'o1', type: 'fee', amount: -100, metadata: { platformFee: 100, processingFee: 0 } }),
    ]);
    const csv = statementCsv({ month: '2026-10', currency: 'PKR', orderNumbers: new Map([['o1', '=HYPERLINK("x")']]) }, lines, totals, true);
    const rows = csv.split('\n');
    expect(rows.find((r) => r.startsWith('"TOTAL"'))).toBe('"TOTAL","","","1000","100","0","0","900",""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(rows[rows.length - 1]).toMatch(/^"TRUNCATED/);
    expect(statementCsv({ month: '2026-10', currency: 'PKR', orderNumbers: new Map() }, lines, totals, false)).not.toContain('TRUNCATED');
  });
});

describe('FinanceService earnings views', () => {
  let service: FinanceService;
  let m: any;

  beforeEach(() => {
    const balance = { storeId: STORE, currency: 'PKR', availableBalance: 5000, pendingBalance: 1000, isFlaggedForReview: false };
    m = {
      balanceModel: { findOne: jest.fn().mockReturnValue(one(balance)), find: jest.fn().mockReturnValue(chain([balance])) },
      txModel: { find: jest.fn().mockReturnValue(chain([])), countDocuments: jest.fn().mockResolvedValue(0), aggregate: jest.fn().mockResolvedValue([]) },
      payoutModel: { find: jest.fn().mockReturnValue(chain([])) },
      methodModel: { find: jest.fn().mockReturnValue(chain([])), findOne: jest.fn().mockReturnValue(one(null)) },
      scheduleModel: { findOne: jest.fn().mockReturnValue(one({ frequency: 'monthly', dayOfMonth: 1, dayOfWeek: 1, nextPayoutAt: new Date(2020, 0, 1) })), find: jest.fn().mockReturnValue(chain([{ currency: 'PKR', frequency: 'monthly', dayOfMonth: 1, dayOfWeek: 1, isEnabled: true, minimumAmount: 1500, nextPayoutAt: new Date(2020, 0, 1) }])) },
      storeModel: { findById: jest.fn().mockResolvedValue({ _id: STORE, sellerId: SELLER, isDelete: false, baseCurrency: 'PKR', name: 'Noor' }) },
      orderModel: { find: jest.fn().mockReturnValue(chain([])) },
    };
    const db: any = { repositories: {
      sellerBalanceModel: m.balanceModel, transactionModel: m.txModel, payoutModel: m.payoutModel, payoutMethodModel: m.methodModel,
      payoutScheduleModel: m.scheduleModel, storeModel: m.storeModel, sellerModel: {}, taxReportModel: {}, orderModel: m.orderModel, campaignModel: {}, saleCreditJobModel: {},
    } };
    const admin: any = { getPayoutFrequency: jest.fn().mockResolvedValue('monthly'), getPlatformFees: jest.fn().mockResolvedValue({ digital: { mode: 'percentage', value: 10 }, physical: { mode: 'percentage', value: 10 } }) };
    const commission: any = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.1, source: 'x' }) };
    service = new FinanceService(db, { log: jest.fn().mockResolvedValue(true) } as any, commission, admin, { notify: jest.fn() } as any, { transaction: jest.fn() } as any);
  });

  it('summary is owner-only: another seller gets 403', async () => {
    await expect(service.getEarningsSummary(OTHER, STORE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getEarningsStatement(OTHER, STORE, { month: '2026-10' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.exportEarningsStatement(OTHER, STORE, { month: '2026-10', format: 'csv' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the next payout date is the same on the overview, the summary and every month view, and ignores a stale stored date', async () => {
    const dash: any = await service.getDashboard(SELLER, STORE);
    const wallet = dash.wallets.find((w: any) => w.currency === 'PKR');
    const summary: any = await service.getEarningsSummary(SELLER, STORE, { currency: 'PKR' });
    const oct: any = await service.getMonthlyStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR' });
    const nov: any = await service.getMonthlyStatement(SELLER, STORE, { month: '2026-11', currency: 'PKR' });

    const expected = nextPayoutDate({ frequency: 'monthly', dayOfMonth: 1 }, new Date())!.toISOString();
    expect(new Date(wallet.nextPayout.scheduledAt).toISOString()).toBe(expected);
    expect(new Date(wallet.payoutSchedule.nextPayoutAt).toISOString()).toBe(expected);
    expect(summary.nextPayoutDate).toBe(expected);
    expect(oct.nextPayoutDate).toBe(expected);
    expect(nov.nextPayoutDate).toBe(expected);
    expect(new Date(expected).getDate()).toBe(1);
  });

  it('nothing payable -> no next payout date on any view', async () => {
    m.balanceModel.findOne.mockReturnValue(one({ storeId: STORE, currency: 'PKR', availableBalance: 0, pendingBalance: 0 }));
    m.balanceModel.find.mockReturnValue(chain([{ storeId: STORE, currency: 'PKR', availableBalance: 0, pendingBalance: 0 }]));
    const dash: any = await service.getDashboard(SELLER, STORE);
    const summary: any = await service.getEarningsSummary(SELLER, STORE, { currency: 'PKR' });
    const oct: any = await service.getMonthlyStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR' });
    expect(dash.wallets[0].nextPayout.scheduledAt).toBeNull();
    expect(summary.nextPayoutDate).toBeNull();
    expect(oct.nextPayoutDate).toBeNull();
  });

  it('summary reports wallet-currency numbers, the default method and the configured fees (no hard-coded rates)', async () => {
    m.methodModel.findOne.mockReturnValue(one({ _id: 'm1', type: 'bank_transfer', bankName: 'HBL', accountLast4: '6702', status: 'active' }));
    const s: any = await service.getEarningsSummary(SELLER, STORE, { currency: 'PKR' });
    expect(s).toMatchObject({ currency: 'PKR', available: 5000, clearing: 1000, commissionOwed: 0 });
    expect(s.defaultMethod).toMatchObject({ last4: '6702' });
    expect(s.platformFees.digital).toEqual({ mode: 'percentage', value: 10 });
  });

  it('statement endpoint: pages of 25 and totals that equal the sum of all rows', async () => {
    const txs: LedgerTx[] = [];
    for (let i = 0; i < 30; i++) {
      txs.push(tx({ referenceId: `o${i}`, type: 'sale', amount: 100 }));
      txs.push(tx({ referenceId: `o${i}`, type: 'fee', amount: -10, metadata: { platformFee: 10, processingFee: 0 } }));
    }
    m.txModel.find.mockReturnValue(chain(txs));
    const p1: any = await service.getEarningsStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR' });
    const p2: any = await service.getEarningsStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR', page: '2' });
    expect(p1.rows).toHaveLength(25);
    expect(p2.rows).toHaveLength(5);
    expect(p1.total).toBe(30);
    expect(p1.totals.net).toBe(30 * 90);
    expect(p1.totals).toEqual(p2.totals);
  });

  it('download is audited before the file is returned, and refused when the audit entry cannot be stored', async () => {
    m.txModel.find.mockReturnValue(chain([tx({ type: 'sale', amount: 100 }), tx({ type: 'fee', amount: -10, metadata: { platformFee: 10 } })]));
    const out = await service.exportEarningsStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR', format: 'csv' });
    expect(out.contentType).toBe('text/csv');
    expect(String(out.body)).toContain('"TOTAL","","","100","10","0","0","90",""');
    const pdf = await service.exportEarningsStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR', format: 'pdf' });
    expect(Buffer.isBuffer(pdf.body) && pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    (service as any).activityLogService.log = jest.fn().mockResolvedValue(false);
    await expect(service.exportEarningsStatement(SELLER, STORE, { month: '2026-10', currency: 'PKR', format: 'csv' })).rejects.toThrow();
  });
});
