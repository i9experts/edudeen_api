/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
/**
 * Runs the REAL FinanceService against a REAL MongoDB replica set and fires the
 * same operation concurrently. Opt-in (needs transactions):
 *
 *   TEST_MONGO_REPLSET_URI='mongodb://127.0.0.1:27018/edudeen_finance_it?replicaSet=rs0' npx jest finance.concurrency
 *
 * Skipped when the variable is not set, so the normal unit run needs no database.
 */
import mongoose from 'mongoose';
import { FinanceService } from './finance.service';
import { SellerBalanceSchema } from './schemas/seller-balance.schema';
import { TransactionSchema } from './schemas/transaction.schema';
import { PayoutSchema } from './schemas/payout.schema';

const URI = process.env.TEST_MONGO_REPLSET_URI;

// These suites drop their database when done — never point them at anything that isn't a throwaway test DB.
if (URI && !/(_it|test)/i.test(new URL(URI).pathname)) throw new Error('Refusing to run: the test database name must contain "_it" or "test"');
const d = URI ? describe : describe.skip;

d('FinanceService — concurrency on a real replica set', () => {
  let conn: mongoose.Connection;
  let service: FinanceService;
  let Balance: mongoose.Model<any>, Tx: mongoose.Model<any>, Payout: mongoose.Model<any>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!).asPromise();
    Balance = conn.model('SellerBalance', SellerBalanceSchema);
    Tx = conn.model('Transaction', TransactionSchema);
    Payout = conn.model('Payout', PayoutSchema);
    await Promise.all([Balance.init(), Tx.init(), Payout.init()]);
    const db: any = { repositories: { sellerBalanceModel: Balance, transactionModel: Tx, payoutModel: Payout, campaignModel: { findByIdAndUpdate: jest.fn() } } };
    const commission: any = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.1, source: 'test' }) };
    service = new FinanceService(db, { log: jest.fn() } as any, commission, {} as any, { notify: jest.fn().mockResolvedValue(undefined) } as any, conn as any);
    const logger = (service as any).logger;
    if (logger) jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  beforeEach(async () => { await Promise.all([Balance.deleteMany({}), Tx.deleteMany({}), Payout.deleteMany({})]); });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
  const bal = async (storeId = 's1') => (await Balance.findOne({ storeId, currency: 'USD' }).lean()) as any;

  it('recordSale: 5 concurrent calls for one order credit the seller exactly once', async () => {
    await settle(Array.from({ length: 5 }, () => service.recordSale('s1', 'seller1', 'order-1', 100, 'Sale', 0, null, 'USD', 'cash_on_delivery')));
    expect(await Tx.countDocuments({ storeId: 's1', type: 'sale', referenceId: 'order-1' })).toBe(1);
    expect((await bal()).pendingBalance).toBe(90); // 100 - 10% commission, once
  });

  it('adminRejectPayout: 5 concurrent rejects refund the seller exactly once', async () => {
    await Balance.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', availableBalance: 60, totalPayouts: 40 });
    const p = await Payout.create({ storeId: 's1', sellerId: 'seller1', amount: 40, currency: 'USD', status: 'processing', payoutMethodId: 'm1', payoutMethodSnapshot: {}, source: 'seller_manual' } as any);
    const res = await settle(Array.from({ length: 5 }, () => service.adminRejectPayout(p._id.toString(), 'admin-1', 'bad details')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await bal()).availableBalance).toBe(100); // 60 + 40 once (not 60 + 5*40)
    expect(await Tx.countDocuments({ type: 'adjustment', referenceId: p._id.toString() })).toBe(1);
  });

  it('approve vs reject race: exactly one wins, and a rejected payout is never also completed', async () => {
    await Balance.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', availableBalance: 60, totalPayouts: 40 });
    const p = await Payout.create({ storeId: 's1', sellerId: 'seller1', amount: 40, currency: 'USD', status: 'processing', payoutMethodId: 'm1', payoutMethodSnapshot: {}, source: 'seller_manual' } as any);
    const id = p._id.toString();
    const res = await settle([service.adminApprovePayout(id, 'a1'), service.adminRejectPayout(id, 'a2', 'nope'), service.adminApprovePayout(id, 'a3'), service.adminRejectPayout(id, 'a4', 'nope')]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const final = (await Payout.findById(id).lean()) as any;
    const refunded = (await bal()).availableBalance === 100;
    expect(refunded).toBe(final.status === 'failed'); // money returned iff payout marked failed
  });

  it('adminRetryFailedPayout: 5 concurrent retries deduct once', async () => {
    await Balance.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', availableBalance: 100, totalPayouts: 0 });
    const p = await Payout.create({ storeId: 's1', sellerId: 'seller1', amount: 40, currency: 'USD', status: 'failed', payoutMethodId: 'm1', payoutMethodSnapshot: {}, source: 'seller_manual' } as any);
    const res = await settle(Array.from({ length: 5 }, () => service.adminRetryFailedPayout(p._id.toString(), 'admin-1')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await bal()).availableBalance).toBe(60);
  });

  it('processClearingBalances: 4 overlapping runs promote a pending sale exactly once', async () => {
    await Balance.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', pendingBalance: 92, availableBalance: 0 });
    await Tx.create({ storeId: 's1', sellerId: 'seller1', currency: 'USD', type: 'sale', amount: 100, balanceBefore: 0, balanceAfter: 0, description: 'Sale', referenceId: 'order-9', referenceType: 'order', status: 'pending', metadata: { netAmount: 92, clearingDays: 0 } });
    await Tx.updateOne({ referenceId: 'order-9' }, { $set: { createdAt: new Date(Date.now() - 86_400_000) } }, { timestamps: false });
    await settle(Array.from({ length: 4 }, () => service.processClearingBalances()));
    const b = await bal();
    expect(b.availableBalance).toBe(92);
    expect(b.pendingBalance).toBe(0);
  });
});
