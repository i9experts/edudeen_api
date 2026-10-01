/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/**
 * Shipping money, on a REAL replica set (opt-in, like the other finance integration specs):
 *   TEST_MONGO_REPLSET_URI='mongodb://127.0.0.1:27018/edudeen_ship_it?replicaSet=rs0' npx jest finance.shipping-credit
 *
 * A store that ships its own physical orders is credited its own shipping line when the PLATFORM
 * collected the money (card / bank transfer), with NO commission on it. When the platform ships,
 * or when the seller's courier collected the cash (COD), there is no shipping credit.
 */
import mongoose from 'mongoose';
import { FinanceService, shippingCreditFor } from './finance.service';
import { SellerBalanceSchema } from './schemas/seller-balance.schema';
import { TransactionSchema } from './schemas/transaction.schema';
import { PayoutSchema } from './schemas/payout.schema';

describe('shippingCreditFor (who is credited the shipping line)', () => {
  const so = {
    fulfillmentType: 'physical',
    fulfillmentMode: 'seller',
    settlementShippingFee: 20,
  };
  it('credits a seller-fulfilled physical sub-order paid by card or bank transfer', () => {
    expect(shippingCreditFor({ paymentType: 'stripe' }, so)).toBe(20);
    expect(shippingCreditFor({ paymentType: 'manual_bank_transfer' }, so)).toBe(
      20,
    );
    expect(
      shippingCreditFor(
        { paymentType: 'stripe' },
        { ...so, fulfillmentMode: null },
      ),
    ).toBe(20); // orders with no mode = seller
  });
  it("never credits platform-fulfilled shipping, COD shipping (the seller's courier collected it), or digital sub-orders", () => {
    expect(
      shippingCreditFor(
        { paymentType: 'stripe' },
        { ...so, fulfillmentMode: 'platform' },
      ),
    ).toBe(0);
    expect(shippingCreditFor({ paymentType: 'cash_on_delivery' }, so)).toBe(0);
    expect(
      shippingCreditFor(
        { paymentType: 'stripe' },
        { ...so, fulfillmentType: 'digital' },
      ),
    ).toBe(0);
    expect(
      shippingCreditFor(
        { paymentType: 'stripe' },
        { fulfillmentType: 'physical', fulfillmentMode: 'seller' },
      ),
    ).toBe(0); // no line recorded
  });
});

const URI = process.env.TEST_MONGO_REPLSET_URI;
if (URI && !/(_it|test)/i.test(new URL(URI).pathname))
  throw new Error(
    'Refusing to run: the test database name must contain "_it" or "test"',
  );
const d = URI ? describe : describe.skip;

d('recordSale with a shipping line — real replica set', () => {
  let conn: mongoose.Connection;
  let service: any;
  let Balance: mongoose.Model<any>,
    Tx: mongoose.Model<any>,
    Payout: mongoose.Model<any>;

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
      },
    };
    const commission: any = {
      resolveRate: jest.fn().mockResolvedValue({ rate: 0.1, source: 'test' }),
    };
    service = new FinanceService(
      db,
      { log: jest.fn() } as any,
      commission,
      {} as any,
      { notify: jest.fn().mockResolvedValue(undefined) } as any,
      conn as any,
    );
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
  });
  beforeEach(async () => {
    await Promise.all([
      Balance.deleteMany({}),
      Tx.deleteMany({}),
      Payout.deleteMany({}),
    ]);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  const bal = async () =>
    (await Balance.findOne({ storeId: 's1', currency: 'USD' }).lean()) as any;
  const sale = (
    orderId: string,
    type: string,
    shipping: number,
    mode = 'seller',
  ) =>
    service.recordSale(
      's1',
      'seller1',
      orderId,
      100,
      'Sale',
      0,
      null,
      'USD',
      type,
      mode,
      shipping,
    );

  it('card: shipping passes through to the seller with NO commission; the card fee is charged on everything the buyer paid', async () => {
    await sale('o1', 'stripe', 20);
    // commission 10% of 100 = 10 (not of 120); card fee = 120 * 2.9% + 0.30 = 3.78; net = 100 - 10 - 3.78 + 20
    expect((await bal()).pendingBalance).toBeCloseTo(106.22, 2);
    const saleTx: any = await Tx.findOne({
      type: 'sale',
      referenceId: 'o1',
    }).lean();
    expect(saleTx.metadata.platformFee).toBe(10);
    expect(saleTx.metadata.shippingCredit).toBe(20);
    const ship: any = await Tx.findOne({
      type: 'adjustment',
      referenceId: 'o1',
    }).lean();
    expect(ship.amount).toBe(20); // separate, informational ledger entry
  });

  it('bank transfer: no card fee, no commission on shipping', async () => {
    await sale('o2', 'manual_bank_transfer', 20);
    expect((await bal()).pendingBalance).toBe(110); // 100 - 10 + 20
  });

  it('no shipping line → unchanged from before (no extra ledger rows)', async () => {
    await sale('o3', 'manual_bank_transfer', 0);
    expect((await bal()).pendingBalance).toBe(90);
    expect(await Tx.countDocuments({ type: 'adjustment' })).toBe(0);
  });

  it('is idempotent per (store, order): 5 concurrent calls credit the sale and the shipping once', async () => {
    await Promise.allSettled(
      Array.from({ length: 5 }, () => sale('o4', 'manual_bank_transfer', 20)),
    );
    expect((await bal()).pendingBalance).toBe(110);
    expect(
      await Tx.countDocuments({ type: 'adjustment', referenceId: 'o4' }),
    ).toBe(1);
  });

  it('seller-collected COD: shipping is never credited (the seller already holds that cash); the commission is debited on the sale only', async () => {
    await sale('o5', 'cash_on_delivery', 20);
    const b = await bal();
    expect(b.pendingBalance).toBe(0);
    expect(b.availableBalance).toBe(-10);
  });

  it('clearing releases the shipping credit together with the sale', async () => {
    await sale('o6', 'manual_bank_transfer', 20);
    await Tx.collection.updateMany(
      { type: 'sale' },
      { $set: { createdAt: new Date(Date.now() - 20 * 86_400_000) } },
    );
    await service.processClearingBalances();
    const b = await bal();
    expect(b.availableBalance).toBe(110);
    expect(b.pendingBalance).toBe(0);
  });

  it('a FREE sale (nothing paid, no subsidy owed) writes no ledger rows and creates no balance', async () => {
    await service.recordSale(
      's1',
      'seller1',
      'free-1',
      0,
      'Sale',
      0,
      null,
      'USD',
      'free',
      'seller',
      0,
    );
    expect(await Tx.countDocuments({})).toBe(0);
    expect(await Balance.countDocuments({})).toBe(0);
  });

  it('a free sale made free by a platform-sponsored discount credits only that sponsored basis, as before', async () => {
    // the buyer paid 0; the platform owes the seller the sponsored 20 (the settlement basis), commission 10% as for any sponsored sale
    await service.recordSale(
      's1',
      'seller1',
      'free-2',
      20,
      'Sale',
      20,
      null,
      'USD',
      'free',
      'seller',
      0,
    );
    expect((await bal()).pendingBalance).toBe(18);
    expect(
      await Tx.countDocuments({ type: 'sale', referenceId: 'free-2' }),
    ).toBe(1);
  });
});
