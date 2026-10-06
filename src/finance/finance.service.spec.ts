/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CommissionRulesService } from '../commission-rules/commission-rules.service';
import { AdminConfigService } from '../admin-config/admin-config.service';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';

/** A chainable `.find()` result stub — `.sort()/.skip()/.limit()/.select()` all
 * return the same chain object (any order, any subset), `.lean()` resolves to
 * `result`, matching every call shape used across finance.service.ts. */
function makeChainableFind(result: any[] = []) {
  const chain: any = {};
  chain.sort = jest.fn().mockReturnValue(chain);
  chain.skip = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.lean = jest.fn().mockResolvedValue(result);
  return chain;
}

/** A minimal Mongoose-Model-like constructor mock: `new Model(doc)` returns an
 * object carrying the doc's fields plus a `.save()` that resolves to itself —
 * enough to exercise FinanceService's `new this.txModel(...); await tx.save()`
 * pattern without needing a real Mongo connection. */
function makeConstructableModelMock() {
  const created: any[] = [];
  let counter = 0;
  const Model: any = jest.fn().mockImplementation((doc: any) => {
    const instance = { _id: `mock-id-${++counter}`, ...doc, save: jest.fn().mockImplementation(async function (this: any) { return this; }) };
    created.push(instance);
    return instance;
  });
  Model.created = created;
  Model.findOne = jest.fn();
  Model.findById = jest.fn();
  Model.find = jest.fn().mockReturnValue(makeChainableFind([]));
  Model.updateOne = jest.fn().mockResolvedValue({});
  Model.countDocuments = jest.fn().mockResolvedValue(0);
  Model.aggregate = jest.fn().mockResolvedValue([]);
  return Model;
}

function makeBalance(overrides: Partial<Record<string, any>> = {}) {
  return {
    storeId: STORE_ID, sellerId: SELLER_ID, currency: 'USD',
    availableBalance: 0, pendingBalance: 0,
    totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0,
    isFlaggedForReview: false, flaggedReason: null, flaggedAt: null,
    save: jest.fn().mockImplementation(async function (this: any) { return this; }),
    ...overrides,
  };
}

process.env.SEO_TOKEN_ENCRYPTION_KEY ??= 'test-only-encryption-key';

describe('FinanceService', () => {
  let service: FinanceService;
  let balanceModel: any;
  let txModel: any;
  let payoutModel: any;
  let methodModel: any;
  let scheduleModel: any;
  let storeModel: any;
  let sellerModel: any;
  let connection: any;
  let activityLogService: ActivityLogService;
  let commissionRulesService: CommissionRulesService;
  let adminConfigService: AdminConfigService;
  let notificationsService: any;

  let orderModel: any;

  beforeEach(() => {
    balanceModel = { findOne: jest.fn(), find: jest.fn().mockReturnValue(makeChainableFind([])) };
    txModel = makeConstructableModelMock();
    txModel.exists = jest.fn().mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
    txModel.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    payoutModel = makeConstructableModelMock();
    payoutModel.exists = jest.fn().mockResolvedValue(false);
    payoutModel.findOneAndUpdate = jest.fn();
    methodModel = { findById: jest.fn(), findOne: jest.fn(), find: jest.fn().mockReturnValue(makeChainableFind([])), exists: jest.fn().mockResolvedValue(true), updateMany: jest.fn() };
    scheduleModel = { findOne: jest.fn(), find: jest.fn().mockReturnValue(makeChainableFind([])), updateOne: jest.fn().mockResolvedValue({}) };
    storeModel = { findById: jest.fn().mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false }) };
    sellerModel = { findById: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Jane Seller' }) }) }) };
    orderModel = { find: jest.fn().mockReturnValue(makeChainableFind([])) };

    const db = {
      repositories: {
        sellerBalanceModel: balanceModel, transactionModel: txModel, payoutModel,
        payoutMethodModel: methodModel, payoutScheduleModel: scheduleModel,
        storeModel, sellerModel, taxReportModel: {}, campaignModel: { findByIdAndUpdate: jest.fn() },
        orderModel,
      },
    } as unknown as DatabaseService;

    activityLogService = { log: jest.fn() } as any;
    commissionRulesService = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.08, source: 'hardcoded_fallback' }) } as any;
    adminConfigService = { getPayoutMinimum: jest.fn().mockResolvedValue(5), getPayoutFrequency: jest.fn().mockResolvedValue('monthly') } as any;
    notificationsService = { notify: jest.fn().mockResolvedValue(undefined) };

    // `connection.transaction(fn)` just runs fn with a stand-in session —
    // no real Mongo transaction semantics needed to unit-test the ledger math.
    connection = { transaction: jest.fn().mockImplementation(async (fn: any) => fn({})) };

    service = new FinanceService(db, activityLogService, commissionRulesService, adminConfigService, notificationsService, connection);
  });

  describe('recordSale', () => {
    it('splits a sale into net seller credit (pending) and a platform+processing fee entry, using the resolved commission rate', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      // saleAmount=100, platformFee=5 (5%), processingFee=100*0.029+0.30=3.20, netAmount=91.80
      await service.recordSale(STORE_ID, SELLER_ID, 'order-1', 100, 'Sale — Order #order-1');

      expect(balance.pendingBalance).toBeCloseTo(91.80, 2);
      expect(balance.totalRevenue).toBe(100);
      expect(balance.totalFees).toBeCloseTo(8.20, 2);

      const saleTx = txModel.created.find((t: any) => t.type === 'sale');
      const feeTx = txModel.created.find((t: any) => t.type === 'fee');
      expect(saleTx.amount).toBe(100);
      expect(saleTx.metadata.feeRateSource).toBe('seller_override');
      expect(feeTx.amount).toBeCloseTo(-8.20, 2);
    });

    it('pays down a prior negative (debt) balance and clears the review flag once both balances are non-negative again', async () => {
      const balance = makeBalance({ pendingBalance: -20, isFlaggedForReview: true, flaggedReason: 'prior debt' });
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0, source: 'seller_override' });

      // saleAmount=100, 0% commission, processingFee=3.20 → net=96.80 credited to pendingBalance (-20 + 96.80 = 76.80 >= 0)
      await service.recordSale(STORE_ID, SELLER_ID, 'order-2', 100, 'desc');

      expect(balance.pendingBalance).toBeCloseTo(76.80, 2);
      expect(balance.isFlaggedForReview).toBe(false);
      expect(balance.flaggedReason).toBeNull();
    });

    it('for a COD sale credits nothing (the seller holds the cash) and records only the platform commission as a debt against availableBalance', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      // saleAmount=100, platformFee=5 (5%), no processing fee → wallet -5, nothing pending
      await service.recordSale(STORE_ID, SELLER_ID, 'order-cod', 100, 'desc', 0, null, 'USD', 'cash_on_delivery');

      expect(balance.pendingBalance).toBe(0);
      expect(balance.availableBalance).toBe(-5);
      expect(balance.totalRevenue).toBe(100);
      expect(balance.totalFees).toBe(5);
      expect(balance.isFlaggedForReview).toBe(true);
      const saleTx = txModel.created.find((t: any) => t.referenceId === 'order-cod' && t.type === 'sale');
      expect(saleTx.metadata.collectedBy).toBe('seller');
      expect(saleTx.status).toBe('completed');
      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-cod' && t.type === 'fee');
      expect(feeTx.amount).toBe(-5);
      expect(feeTx.metadata.processingFee).toBe(0);
      expect(feeTx.description).toContain('Platform commission owed on cash order');
    });

    it('does not charge a card-processing fee for a manual bank-transfer sale either', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.03, source: 'platform_plan' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-mbt', 27800, 'desc', 0, null, 'PKR', 'manual_bank_transfer');

      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-mbt' && t.type === 'fee');
      expect(feeTx.amount).toBeCloseTo(-834, 2); // 3% of 27800, no processing fee
    });

    it('still charges the card-processing fee for a Stripe sale', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-stripe', 100, 'desc', 0, null, 'USD', 'stripe');

      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-stripe' && t.type === 'fee');
      expect(feeTx.amount).toBeCloseTo(-8.20, 2); // 5 (platform) + 3.20 (processing)
    });
  });

  describe('recordRefund', () => {
    it('deducts fully from availableBalance when it covers the refund', async () => {
      const balance = makeBalance({ availableBalance: 100, pendingBalance: 0 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-3', 40);

      expect(balance.availableBalance).toBe(60);
      expect(balance.pendingBalance).toBe(0);
      expect(balance.isFlaggedForReview).toBe(false);
    });

    it('spills into pendingBalance once availableBalance is exhausted', async () => {
      const balance = makeBalance({ availableBalance: 10, pendingBalance: 50 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-4', 30);

      expect(balance.availableBalance).toBe(0);
      expect(balance.pendingBalance).toBe(30); // 50 - (30 - 10)
      expect(balance.isFlaggedForReview).toBe(false);
    });

    it('drives the balance negative and flags the seller for admin review when the refund exceeds everything held (seller already withdrew it) — does not silently ignore the overflow', async () => {
      const balance = makeBalance({ availableBalance: 5, pendingBalance: 10 });
      balanceModel.findOne.mockResolvedValue(balance);

      const result = await service.recordRefund(STORE_ID, SELLER_ID, 'order-5', 50);

      expect(balance.availableBalance).toBe(0);
      expect(balance.pendingBalance).toBe(-35); // 10 - (50 - 5)
      expect(balance.isFlaggedForReview).toBe(true);
      expect(balance.flaggedReason).toContain('exceeded');
      expect(result.balanceAfter).toBe(0);

      // Admin-visible security alert fired exactly once for the negative flip.
      expect(activityLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'seller_balance_negative', isSecurityAlert: true }),
      );
    });

    it('for a refunded COD sale does not debit the wallet and reverses the commission debt pro-rata', async () => {
      const balance = makeBalance({ availableBalance: -5, isFlaggedForReview: true, flaggedReason: 'cod debt' });
      balanceModel.findOne.mockResolvedValue(balance);
      txModel.findOne.mockResolvedValue({ amount: 100, metadata: { platformFee: 5, collectedBy: 'seller' } });

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-cod', 100);

      expect(balance.availableBalance).toBe(0);
      expect(balance.pendingBalance).toBe(0);
      expect(balance.totalRefunds).toBe(100);
      expect(balance.isFlaggedForReview).toBe(false);
      const reversal = txModel.created.find((t: any) => t.type === 'adjustment');
      expect(reversal.amount).toBe(5);
      expect(reversal.metadata.codCommissionReversal).toBe(true);
    });

    it('does not re-fire the negative-balance alert on a second refund while already flagged', async () => {
      const balance = makeBalance({ availableBalance: 0, pendingBalance: -35, isFlaggedForReview: true, flaggedReason: 'already flagged' });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-6', 10);

      expect(balance.pendingBalance).toBe(-45);
      expect(activityLogService.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'seller_balance_negative' }),
      );
    });
  });

  describe('requestPayout', () => {
    it('rejects a payout method that is not active yet', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'pending_verification', currency: 'USD' });

      await expect(
        service.requestPayout(SELLER_ID, STORE_ID, { amount: 10, payoutMethodId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an amount below the configured per-currency minimum', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'PKR', type: 'jazzcash' });
      adminConfigService.getPayoutMinimum = jest.fn().mockResolvedValue(1500);

      await expect(
        service.requestPayout(SELLER_ID, STORE_ID, { amount: 500, payoutMethodId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(adminConfigService.getPayoutMinimum).toHaveBeenCalledWith('PKR');
    });

    it('rejects a withdrawal larger than the available balance', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'USD', type: 'bank_transfer' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 20 }));

      await expect(
        service.requestPayout(SELLER_ID, STORE_ID, { amount: 50, payoutMethodId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('debits the available balance and creates a processing payout + ledger entry on success', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'USD', type: 'bank_transfer', bankName: 'Chase', accountLast4: '1234' });
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);

      const payout = await service.requestPayout(SELLER_ID, STORE_ID, { amount: 40, payoutMethodId: 'm1' } as any);

      expect(balance.availableBalance).toBe(60);
      expect(balance.totalPayouts).toBe(40);
      expect(payout.status).toBe('processing');
      expect(txModel.created.find((t: any) => t.type === 'payout').amount).toBe(-40);
    });
  });

  describe('adminRejectPayout', () => {
    const statusLookup = (status: string | null) => {
      payoutModel.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(status ? { status } : null) }) });
    };

    it('claims the payout atomically, then reverses the deduction onto the available balance', async () => {
      const payout = { _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD', status: 'failed' };
      payoutModel.findOneAndUpdate.mockResolvedValue(payout);
      const balance = makeBalance({ availableBalance: 60, totalPayouts: 40 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.adminRejectPayout('p1', 'admin-1', 'bank details invalid');

      expect(payoutModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'p1', status: { $in: ['pending', 'processing'] } },
        { $set: expect.objectContaining({ status: 'failed', failureReason: 'bank details invalid' }) },
        expect.objectContaining({ session: expect.anything() }),
      );
      expect(balance.availableBalance).toBe(100);
      expect(balance.totalPayouts).toBe(0);
    });

    it('a second (concurrent / double-click) reject loses the claim and credits NOTHING', async () => {
      payoutModel.findOneAndUpdate.mockResolvedValue(null); // another request already moved it to failed
      statusLookup('failed');
      const balance = makeBalance({ availableBalance: 100, totalPayouts: 0 });
      balanceModel.findOne.mockResolvedValue(balance);

      await expect(service.adminRejectPayout('p1', 'admin-1', 'reason')).rejects.toThrow(/status "failed"/);
      expect(balance.availableBalance).toBe(100);
      expect(balance.save).not.toHaveBeenCalled();
      expect(txModel.created).toHaveLength(0);
    });

    it('throws BadRequest when the payout is already completed', async () => {
      payoutModel.findOneAndUpdate.mockResolvedValue(null);
      statusLookup('completed');
      await expect(service.adminRejectPayout('p1', 'admin-1', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for a missing payout', async () => {
      payoutModel.findOneAndUpdate.mockResolvedValue(null);
      statusLookup(null);
      await expect(service.adminRejectPayout('missing', 'admin-1', 'reason')).rejects.toThrow(NotFoundException);
    });
  });

  describe('adminApprovePayout', () => {
    it('only one approve wins; a reject-after-approve cannot refund money that was wired', async () => {
      payoutModel.findOne = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ payoutMethodId: 'admin-manual' }) }) });
      payoutModel.findOneAndUpdate.mockResolvedValueOnce({ _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'PKR', status: 'completed' }).mockResolvedValueOnce(null);
      payoutModel.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: 'completed' }) }) });
      await service.adminApprovePayout('p1', 'admin-1');
      await expect(service.adminApprovePayout('p1', 'admin-2')).rejects.toThrow(/status "completed"/);
      expect(activityLogService.log).toHaveBeenCalledTimes(1);
      expect((activityLogService.log as jest.Mock).mock.calls[0][0].description).toContain('PKR 40.00'); // not a hard-coded $
    });
  });

  describe('adminRetryFailedPayout', () => {
    it('a second concurrent retry finds nothing to claim and does not deduct again', async () => {
      payoutModel.findOneAndUpdate.mockResolvedValue(null);
      payoutModel.exists.mockResolvedValue({ _id: 'p1' });
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);
      await expect(service.adminRetryFailedPayout('p1', 'admin-1')).rejects.toThrow(/Only failed payouts/);
      expect(balance.availableBalance).toBe(100);
    });
  });

  describe('processClearingBalances', () => {
    const oldSale = { _id: 'tx1', storeId: STORE_ID, sellerId: SELLER_ID, currency: 'USD', createdAt: new Date(Date.now() - 400 * 24 * 3600 * 1000), metadata: { netAmount: 92, clearingDays: 7 } };

    it('credits available balance once, only after winning the pending→completed claim', async () => {
      txModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([oldSale]) });
      const balance = makeBalance({ pendingBalance: 92 });
      balanceModel.findOne.mockResolvedValue(balance);
      const res = await service.processClearingBalances();
      expect(txModel.updateOne).toHaveBeenCalledWith({ _id: 'tx1', status: 'pending' }, { $set: { status: 'completed' } }, expect.anything());
      expect(balance.availableBalance).toBe(92);
      expect(res.processed).toBe(1);
    });

    it('a concurrent run that loses the claim credits nothing (no double credit)', async () => {
      txModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([oldSale]) });
      txModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const balance = makeBalance({ pendingBalance: 92 });
      balanceModel.findOne.mockResolvedValue(balance);
      const res = await service.processClearingBalances();
      expect(balance.availableBalance).toBe(0);
      expect(balance.save).not.toHaveBeenCalled();
      expect(res).toEqual({ processed: 0, totalAmount: 0, byCurrency: [] });
    });

    it('one poison row does not stop later sales from clearing', async () => {
      const second = { ...oldSale, _id: 'tx2', storeId: 'store-2' };
      txModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([oldSale, second]) });
      const good = makeBalance({ pendingBalance: 92 });
      balanceModel.findOne.mockImplementation(async (q: any) => { if (q.storeId === STORE_ID) throw new Error('boom'); return good; });
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      const res = await service.processClearingBalances();
      expect(res.processed).toBe(1);
      expect(good.availableBalance).toBe(92);
    });
  });

  describe('recordSale idempotency', () => {
    it('does not credit again when a sale for the same order+store is already recorded', async () => {
      txModel.exists.mockReturnValue({ session: jest.fn().mockResolvedValue({ _id: 'existing' }) });
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      await service.recordSale(STORE_ID, SELLER_ID, 'order-1', 100, 'Sale');
      expect(balance.pendingBalance).toBe(0);
      expect(balance.save).not.toHaveBeenCalled();
      expect(txModel.created).toHaveLength(0);
      expect(txModel.exists).toHaveBeenCalledWith({ storeId: STORE_ID, referenceId: 'order-1', referenceType: 'order', type: 'sale' });
    });
  });

  describe('processScheduledPayouts', () => {
    function makeSchedule(overrides: Partial<Record<string, any>> = {}) {
      return {
        _id: 'sched-1', storeId: STORE_ID, sellerId: SELLER_ID, currency: 'USD',
        frequency: 'weekly', dayOfWeek: 1, dayOfMonth: 1, minimumAmount: 50,
        isEnabled: true, defaultPayoutMethodId: 'm1', nextPayoutAt: new Date(Date.now() - 1000),
        ...overrides,
      };
    }

    it('advances nextPayoutAt and skips a schedule with no default payout method', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule({ defaultPayoutMethodId: null })]) });

      const result = await service.processScheduledPayouts();

      expect(scheduleModel.updateOne).toHaveBeenCalledWith({ _id: 'sched-1' }, { $set: { nextPayoutAt: expect.any(Date) } });
      expect(result).toEqual({ schedulesChecked: 1, payoutsCreated: 0, totalAmount: 0, skipped: 1 });
    });

    it('skips when the default payout method is missing or not active', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule()]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'pending_verification' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 200 }));

      const result = await service.processScheduledPayouts();
      expect(result.payoutsCreated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('skips a store that already has a payout in flight, to avoid stacking requests', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule()]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'active', type: 'bank_transfer', currency: 'USD' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 200 }));
      payoutModel.exists.mockResolvedValue(true);

      const result = await service.processScheduledPayouts();
      expect(result.payoutsCreated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('skips when available balance is below the greater of the schedule minimum and the platform floor', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule({ minimumAmount: 100 })]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'active', type: 'bank_transfer', currency: 'USD' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 80 }));

      const result = await service.processScheduledPayouts();
      expect(result.payoutsCreated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('sweeps the full available balance into a scheduled_auto payout and notifies the seller', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule({ minimumAmount: 50 })]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'active', type: 'bank_transfer', bankName: 'Chase', currency: 'USD' });
      const balance = makeBalance({ availableBalance: 200 });
      balanceModel.findOne.mockResolvedValue(balance);

      const result = await service.processScheduledPayouts();

      expect(result).toEqual({ schedulesChecked: 1, payoutsCreated: 1, totalAmount: 200, skipped: 0 });
      expect(balance.availableBalance).toBe(0);
      const payout = payoutModel.created.find((p: any) => p.source === 'scheduled_auto');
      expect(payout.amount).toBe(200);
      expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'payout_auto_initiated', recipientId: SELLER_ID }));
    });

    it("keeps processing the remaining schedules when one schedule's lookup throws", async () => {
      scheduleModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeSchedule({ _id: 'sched-bad', storeId: 'store-bad' }), makeSchedule({ _id: 'sched-2', storeId: 'store-2' })]),
      });
      methodModel.findById = jest.fn()
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValueOnce({ _id: 'm1', status: 'active', type: 'bank_transfer', currency: 'USD' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 200 }));

      const result = await service.processScheduledPayouts();
      expect(result.schedulesChecked).toBe(2);
      expect(result.payoutsCreated).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('adminGetSellerFinancialDetails', () => {
    it('returns every currency balance/schedule the store holds, not just USD', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([
        makeBalance({ currency: 'USD', availableBalance: 50 }),
        makeBalance({ currency: 'PKR', availableBalance: 27800 }),
      ]));
      scheduleModel.find.mockReturnValue(makeChainableFind([
        { currency: 'USD', frequency: 'weekly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null },
        { currency: 'PKR', frequency: 'weekly', isEnabled: true, minimumAmount: 1500, nextPayoutAt: null },
      ]));

      const result = await service.adminGetSellerFinancialDetails(STORE_ID);

      expect(result.balances).toHaveLength(2);
      expect(result.balances.map((b: any) => b.currency)).toEqual(['USD', 'PKR']);
      expect(result.payoutSchedules).toHaveLength(2);
    });

    it('falls back to a zeroed USD placeholder for a brand-new store with no balance doc yet', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([]));

      const result = await service.adminGetSellerFinancialDetails(STORE_ID);

      expect(result.balances).toEqual([expect.objectContaining({ currency: 'USD', availableBalance: 0 })]);
    });
  });

  describe('getDashboard', () => {
    it('defaults to a single zeroed USD wallet for a brand-new store with no balance/schedule docs yet', async () => {
      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets).toHaveLength(1);
      expect(result.wallets[0]).toEqual(expect.objectContaining({ currency: 'USD', availableBalance: 0, pendingBalance: 0 }));
    });

    it('returns one wallet per currency the store holds, each with its own balance, schedule, and default payout method', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([
        makeBalance({ currency: 'USD', availableBalance: 50 }),
        makeBalance({ currency: 'PKR', availableBalance: 27800 }),
      ]));
      scheduleModel.find.mockReturnValue(makeChainableFind([
        { currency: 'USD', frequency: 'weekly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null },
        { currency: 'PKR', frequency: 'weekly', isEnabled: true, minimumAmount: 1500, nextPayoutAt: null },
      ]));
      methodModel.find.mockReturnValue(makeChainableFind([
        { type: 'bank_transfer', currency: 'USD', isDefault: true, bankName: 'Chase', accountLast4: '1234' },
        { type: 'jazzcash', currency: 'PKR', isDefault: true, bankName: null, accountLast4: null },
      ]));

      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets).toHaveLength(2);
      const usdWallet: any = result.wallets.find((w: any) => w.currency === 'USD');
      const pkrWallet: any = result.wallets.find((w: any) => w.currency === 'PKR');
      expect(usdWallet.availableBalance).toBe(50);
      expect(usdWallet.nextPayout.method.type).toBe('bank_transfer');
      expect(pkrWallet.availableBalance).toBe(27800);
      expect(pkrWallet.nextPayout.method.type).toBe('jazzcash');
    });

    it('does not create a phantom second wallet when a legacy schedule doc predates the currency field (lean reads skip Mongoose defaults)', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([makeBalance({ currency: 'USD', availableBalance: 50 })]));
      // No `currency` key at all — simulates a doc saved before this field existed on the schema.
      scheduleModel.find.mockReturnValue(makeChainableFind([{ frequency: 'weekly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null }]));

      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets).toHaveLength(1);
      expect(result.wallets[0].currency).toBe('USD');
    });
  });

  describe('payout-method defaults are scoped per currency', () => {
    it("adding a store's first PKR method only checks/unsets PKR defaults, never touching the USD default", async () => {
      methodModel.exists = jest.fn().mockResolvedValue(false);
      methodModel.create = jest.fn().mockResolvedValue({ _id: 'm2', currency: 'PKR', isDefault: true });

      await service.addPayoutMethod(SELLER_ID, STORE_ID, { type: 'jazzcash', externalAccountId: '03001234567' } as any);

      expect(methodModel.exists).toHaveBeenCalledWith({ storeId: STORE_ID, currency: 'PKR' });
      expect(methodModel.updateMany).toHaveBeenCalledWith(
        { storeId: STORE_ID, currency: 'PKR', _id: { $ne: 'm2' } },
        { $set: { isDefault: false } },
      );
    });

    it('setting a PKR method as default only clears other PKR defaults, not the USD one', async () => {
      methodModel.findOne = jest.fn().mockResolvedValue({ _id: 'm2', storeId: STORE_ID, currency: 'PKR', isDefault: false, save: jest.fn() });

      await service.setDefaultPayoutMethod(SELLER_ID, STORE_ID, 'm2');

      expect(methodModel.updateMany).toHaveBeenCalledWith({ storeId: STORE_ID, currency: 'PKR' }, { $set: { isDefault: false } });
    });
  });

  describe('adminGetPlatformTransactions — paymentMethodType filter', () => {
    it('resolves matching order ids first and constrains the ledger query to them', async () => {
      orderModel.find.mockReturnValue(makeChainableFind([{ _id: 'order-1' }, { _id: 'order-2' }]));

      await service.adminGetPlatformTransactions({ paymentMethodType: 'manual_bank_transfer' });

      expect(orderModel.find).toHaveBeenCalledWith({ paymentType: 'manual_bank_transfer' });
      expect(txModel.find).toHaveBeenCalledWith(expect.objectContaining({
        referenceId: { $in: ['order-1', 'order-2'] }, referenceType: 'order',
      }));
    });

    it('does not touch the order model at all when no paymentMethodType filter is given', async () => {
      await service.adminGetPlatformTransactions({});
      expect(orderModel.find).not.toHaveBeenCalled();
    });
  });

  describe('updatePayoutMethod', () => {
    it('resets an active method back to pending_verification when the account number changes, clearing prior verification', async () => {
      const method: any = {
        _id: 'm1', storeId: STORE_ID, status: 'active', bankName: 'Chase', accountLast4: '1234',
        verifiedByAdminId: 'admin-1', verifiedAt: new Date(), save: jest.fn(),
      };
      methodModel.findOne.mockResolvedValue(method);

      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { accountNumber: '999999999999' } as any);

      expect(method.status).toBe('pending_verification');
      expect(method.verifiedByAdminId).toBeNull();
      expect(method.verifiedAt).toBeNull();
      expect(method.accountLast4).toBe('9999');
    });

    it('does not touch verification status when nothing sensitive changed (e.g. only accountHolder)', async () => {
      const method: any = {
        _id: 'm1', storeId: STORE_ID, status: 'active', bankName: 'Chase', accountLast4: '1234',
        verifiedByAdminId: 'admin-1', verifiedAt: new Date(), save: jest.fn(),
      };
      methodModel.findOne.mockResolvedValue(method);

      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { accountHolder: 'Jane Seller' } as any);

      expect(method.status).toBe('active');
      expect(method.verifiedByAdminId).toBe('admin-1');
    });

    it('flags an account-title mismatch against the soft check when accountHolder is updated', async () => {
      const method: any = { _id: 'm1', storeId: STORE_ID, status: 'pending_verification', save: jest.fn() };
      methodModel.findOne.mockResolvedValue(method);

      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { accountHolder: 'Someone Else Entirely' } as any);

      expect(method.accountTitleMismatchFlagged).toBe(true);
    });
  });

  describe('payout hardening', () => {
    const selLean = (v: any) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }) });

    it('rejects a payout request with more than 2 decimals or a non-positive amount', async () => {
      methodModel.findById.mockResolvedValue({ storeId: STORE_ID, status: 'active', currency: 'USD' });
      await expect(service.requestPayout(SELLER_ID, STORE_ID, { amount: 10.005, payoutMethodId: 'm1' } as any)).rejects.toThrow(/2 decimal/);
      await expect(service.requestPayout(SELLER_ID, STORE_ID, { amount: -5, payoutMethodId: 'm1' } as any)).rejects.toThrow(/positive/);
      await expect(service.requestPayout(SELLER_ID, STORE_ID, { amount: NaN, payoutMethodId: 'm1' } as any)).rejects.toThrow(BadRequestException);
    });

    it('approve refuses when the payout method was edited back to pending_verification after the request', async () => {
      payoutModel.findOne = jest.fn().mockReturnValue(selLean({ payoutMethodId: 'm1' }));
      methodModel.findById.mockReturnValue(selLean({ status: 'pending_verification' }));
      await expect(service.adminApprovePayout('p1', 'admin-1')).rejects.toThrow(/no longer verified/);
      expect(payoutModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('approve refuses when the payout method was deleted', async () => {
      payoutModel.findOne = jest.fn().mockReturnValue(selLean({ payoutMethodId: 'gone' }));
      methodModel.findById.mockReturnValue(selLean(null));
      await expect(service.adminApprovePayout('p1', 'admin-1')).rejects.toThrow(/no longer verified/);
    });

    it('changing a verified method\'s currency sends it back to verification', async () => {
      const method: any = { _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'USD', bankName: 'B', accountLast4: '1234', verifiedByAdminId: 'a', verifiedAt: new Date(), save: jest.fn() };
      methodModel.findOne.mockResolvedValue(method);
      jest.spyOn(service as any, 'checkAccountTitleMismatch').mockResolvedValue({ flagged: false, note: null });
      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { currency: 'PKR' } as any);
      expect(method.status).toBe('pending_verification');
      expect(method.verifiedAt).toBeNull();
    });

    it('manual payout refuses an unverified method and a repeat of an identical payout within a minute', async () => {
      storeModel.findById.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false });
      methodModel.findOne.mockResolvedValue({ status: 'pending_verification', currency: 'USD', type: 'bank' });
      await expect(service.adminCreateManualPayout(STORE_ID, 'admin-1', 25, 'm1', undefined)).rejects.toThrow(/not verified/);

      methodModel.findOne.mockResolvedValue({ status: 'active', currency: 'USD', type: 'bank', bankName: 'B' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 500 }));
      payoutModel.exists = jest.fn().mockReturnValue({ session: jest.fn().mockResolvedValue({ _id: 'earlier' }) });
      await expect(service.adminCreateManualPayout(STORE_ID, 'admin-1', 25, 'm1', undefined)).rejects.toThrow(/refusing to pay twice/);
    });
  });
});
