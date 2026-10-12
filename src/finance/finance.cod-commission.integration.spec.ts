/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/**
 * COD money hotfix, proven on a REAL MongoDB replica set (ledger writes use
 * session transactions). Opt-in, like the other finance integration specs:
 *
 *   TEST_MONGO_REPLSET_URI='mongodb://127.0.0.1:27018/edudeen_cod_it?replicaSet=rs0' npx jest finance.cod-commission
 *
 * Bug being fixed: a Cash-on-Delivery order collected by the SELLER'S courier
 * was credited to the seller as sale-minus-commission when marked paid — the
 * platform paid out money it never received. For seller-collected COD the
 * commission is now DEBITED instead (the balance may go negative), payouts are
 * blocked while negative, later card sales net the debt off, and a return
 * credits the commission back in proportion.
 */
import mongoose from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { SellerBalanceSchema } from './schemas/seller-balance.schema';
import { TransactionSchema } from './schemas/transaction.schema';
import { PayoutSchema } from './schemas/payout.schema';

const URI = process.env.TEST_MONGO_REPLSET_URI;
if (URI && !/(_it|test)/i.test(new URL(URI).pathname)) throw new Error('Refusing to run: the test database name must contain "_it" or "test"');
const d = URI ? describe : describe.skip;

d('COD commission debit (seller-collected cash) — real replica set', () => {
  let conn: mongoose.Connection;
  // `any`: the new trailing recordSale parameter / new methods don't exist on the pre-fix code
  let service: any;
  let Balance: mongoose.Model<any>, Tx: mongoose.Model<any>, Payout: mongoose.Model<any>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!).asPromise();
    Balance = conn.model('SellerBalance', SellerBalanceSchema);
    Tx = conn.model('Transaction', TransactionSchema);
    Payout = conn.model('Payout', PayoutSchema);
    await Promise.all([Balance.init(), Tx.init(), Payout.init()]);
    const db: any = {
      repositories: {
        sellerBalanceModel: Balance,
        transactionModel: Tx,
        payoutModel: Payout,
        campaignModel: { findByIdAndUpdate: jest.fn() },
        storeModel: { findById: jest.fn().mockResolvedValue({ _id: 's1', sellerId: 'seller1', isDelete: false }) },
        payoutMethodModel: {
          findById: jest.fn().mockResolvedValue({ _id: 'm1', storeId: 's1', status: 'active', currency: 'USD', type: 'bank', bankName: 'Bank', accountLast4: '1234' }),
        },
      },
    };
    const commission: any = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.1, source: 'test' }) };
    const adminConfig: any = { getPayoutMinimum: jest.fn().mockResolvedValue(5) };
    service = new FinanceService(db, { log: jest.fn() } as any, commission, adminConfig, { notify: jest.fn().mockResolvedValue(undefined) } as any, conn as any);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  });
  beforeEach(async () => {
    await Promise.all([Balance.deleteMany({}), Tx.deleteMany({}), Payout.deleteMany({})]);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  const bal = async () => (await Balance.findOne({ storeId: 's1', currency: 'USD' }).lean()) as any;
  // createdAt is immutable in the schema, so age the rows through the native driver
  const ageSales = () => Tx.collection.updateMany({ type: 'sale' }, { $set: { createdAt: new Date(Date.now() - 20 * 86_400_000) } });
  const cod = (orderId: string, amount = 100, sponsored = 0, mode?: string) =>
    service.recordSale('s1', 'seller1', orderId, amount, 'Sale', sponsored, null, 'USD', 'cash_on_delivery', mode);
  const refundArgs = (orderId: string, refunded: number, total: number, refKey: string, mode?: string) => ({
    order: { paymentType: 'cash_on_delivery' },
    sellerOrder: { fulfillmentMode: mode },
    storeId: 's1', sellerId: 'seller1', orderId,
    refundedBuyerAmount: refunded, sellerOrderTotal: total, sellerDebitAmount: refunded,
    refKey, currency: 'USD', description: 'Return',
  });

  // 1
  it('fake order: seller buys own product via COD and marks it paid → balance goes DOWN by the commission, never up; payout rejected', async () => {
    await cod('order-cod-1');

    const b = await bal();
    expect(b.availableBalance).toBe(-10); // 10% commission debited
    expect(b.pendingBalance).toBe(0); // nothing credited
    expect(b.isFlaggedForReview).toBe(true);
    expect(await Tx.countDocuments({ storeId: 's1', type: 'sale' })).toBe(0);
    expect(((await Tx.findOne({ storeId: 's1', type: 'fee', referenceId: 'order-cod-1' }).lean()) as any).amount).toBe(-10);

    await expect(service.requestPayout('seller1', 's1', { amount: 5, payoutMethodId: 'm1' })).rejects.toThrow(BadRequestException);
    await expect(service.requestPayout('seller1', 's1', { amount: 5, payoutMethodId: 'm1' })).rejects.toThrow(/Insufficient balance/);
    expect(await Payout.countDocuments({})).toBe(0);
  });

  // 2
  it('is idempotent per (store, order): markPaid then the completed transition, and 5 concurrent calls → exactly one debit', async () => {
    await cod('order-cod-2'); // markPaid
    await cod('order-cod-2', 100, 0, 'seller'); // later status → completed
    await Promise.allSettled(Array.from({ length: 5 }, () => cod('order-cod-2')));
    expect((await bal()).availableBalance).toBe(-10);
    expect(await Tx.countDocuments({ storeId: 's1', type: 'fee', referenceId: 'order-cod-2' })).toBe(1);
  });

  // 3
  it('does not debit an order the pre-hotfix code already credited (it has a sale row)', async () => {
    await cod('order-legacy', 100, 0, 'platform'); // writes a sale row, as the old code did
    await cod('order-legacy', 100, 0, 'seller');
    const b = await bal();
    expect(b.availableBalance).toBe(0);
    expect(b.pendingBalance).toBe(90);
    expect(await Tx.countDocuments({ storeId: 's1', referenceId: 'order-legacy', 'metadata.codCommission': true })).toBe(0);
  });

  // 4
  it('platform-sponsored discount on a COD order: net = sponsored credit − commission', async () => {
    await cod('order-cod-4', 100, 20);
    expect((await bal()).availableBalance).toBe(10); // -10 commission + 20 subsidy
    expect(await Tx.countDocuments({ type: 'platform_subsidy', referenceId: 'order-cod-4' })).toBe(1);
  });

  // 5
  it('full COD return credits the whole commission back and writes no refund debit', async () => {
    await cod('order-cod-5');
    await service.recordRefundForSellerOrder(refundArgs('order-cod-5', 100, 100, 'return-A'));
    const b = await bal();
    expect(b.availableBalance).toBe(0); // -10 + 10
    expect(b.isFlaggedForReview).toBe(false);
    expect(await Tx.countDocuments({ type: 'refund' })).toBe(0);
  });

  it('partial COD returns credit back proportionally, are idempotent per return, and never exceed the commission', async () => {
    await cod('order-cod-5b', 200); // commission 20
    await service.recordRefundForSellerOrder(refundArgs('order-cod-5b', 50, 200, 'return-1')); // 25% → 5
    await service.recordRefundForSellerOrder(refundArgs('order-cod-5b', 50, 200, 'return-1')); // replay → nothing
    expect((await bal()).availableBalance).toBe(-15);
    await service.recordRefundForSellerOrder(refundArgs('order-cod-5b', 100, 200, 'return-2')); // 50% → 10
    expect((await bal()).availableBalance).toBe(-5);
    await service.recordRefundForSellerOrder(refundArgs('order-cod-5b', 200, 200, 'return-3')); // would be 20, only 5 left
    expect((await bal()).availableBalance).toBe(0);
    expect(await Tx.countDocuments({ type: 'adjustment', referenceId: 'order-cod-5b' })).toBe(3);
    expect(await Tx.countDocuments({ type: 'refund' })).toBe(0);
  });

  it('a COD order settled by the OLD sale credit still debits the refund as before; so do card and platform-COD orders', async () => {
    await cod('order-legacy-2', 100, 0, 'platform'); // sale credit (pending 90)
    await service.recordRefundForSellerOrder(refundArgs('order-legacy-2', 40, 100, 'return-L'));
    expect(await Tx.countDocuments({ type: 'refund', referenceId: 'order-legacy-2' })).toBe(1);
    await service.recordRefundForSellerOrder({ ...refundArgs('order-legacy-2', 10, 100, 'return-P', 'platform') });
    expect(await Tx.countDocuments({ type: 'refund', referenceId: 'order-legacy-2' })).toBe(2);
  });

  // 6
  it('payout is blocked while negative even with a card sale pending; after clearing the debt is netted and only the positive remainder is withdrawable', async () => {
    await cod('order-cod-6'); // -10 available
    await service.recordSale('s1', 'seller1', 'order-card-6', 100, 'Sale', 0, null, 'USD', 'stripe', 'seller'); // 86.8 pending
    await expect(service.requestPayout('seller1', 's1', { amount: 5, payoutMethodId: 'm1' })).rejects.toThrow(/Insufficient balance/);

    await ageSales();
    await service.processClearingBalances();

    const b = await bal();
    expect(b.pendingBalance).toBe(0);
    expect(b.availableBalance).toBeCloseTo(76.8, 2); // 86.8 - 10 debt
    expect(b.isFlaggedForReview).toBe(false);
    await expect(service.requestPayout('seller1', 's1', { amount: 80, payoutMethodId: 'm1' })).rejects.toThrow(/Insufficient balance/);
    await expect(service.requestPayout('seller1', 's1', { amount: 70, payoutMethodId: 'm1' })).resolves.toBeDefined();
  });

  // 7
  it('refund overdraft sitting in pendingBalance is netted at clearing instead of forgiven (BREAKING for all sellers)', async () => {
    // A refund overdrew the seller: pending -50. A 100 sale then lands: pending 50.
    await Balance.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', availableBalance: 0, pendingBalance: 50 });
    await Tx.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', type: 'sale', amount: 100, balanceBefore: 0, balanceAfter: 0, description: 'Sale', referenceId: 'order-x', referenceType: 'order', status: 'pending', metadata: { netAmount: 100, clearingDays: 0 } });
    await ageSales();
    await service.processClearingBalances();

    const b = await bal();
    expect(b.availableBalance).toBe(50); // old code released the full 100 and forgave the 50 debt
    expect(b.pendingBalance).toBe(0);
  });

  // 8
  it("'platform' fulfillment COD is unchanged: the platform collected the cash, admin confirms, the seller is credited sale minus commission", async () => {
    await cod('order-cod-8', 100, 0, 'platform');
    const b = await bal();
    expect(b.pendingBalance).toBe(90);
    expect(b.availableBalance).toBe(0);
    expect(await Tx.countDocuments({ storeId: 's1', type: 'sale', referenceId: 'order-cod-8' })).toBe(1);
  });

  it('card sales are unchanged by the fix', async () => {
    await service.recordSale('s1', 'seller1', 'order-card-1', 100, 'Sale', 0, null, 'USD', 'stripe', 'seller');
    expect((await bal()).pendingBalance).toBeCloseTo(86.8, 2); // 100 - 10 - (2.9% + 0.30)
  });
});
