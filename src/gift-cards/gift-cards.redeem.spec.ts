/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy / integration tests */
/**
 * Unit tests always run. The "real MongoDB" block runs only when
 * TEST_MONGO_REPLSET_URI (or TEST_MONGO_URI) is set:
 *   TEST_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_gc_it?replicaSet=rs0' npx jest gift-cards.redeem
 */
import mongoose from 'mongoose';
import { GiftCardsService } from './gift-cards.service';
import { GiftCardSchema } from './schemas/gift-card.schema';
import { GiftCardTransactionSchema } from './schemas/gift-card-transaction.schema';

const build = (giftCardModel: any, giftCardTransactionModel: any) => {
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new GiftCardsService({ repositories: { giftCardModel, giftCardTransactionModel } } as any, activity, {} as any, {} as any, { get: jest.fn() } as any);
  return { svc, activity };
};

describe('GiftCardsService.redeemAtOrderPlacement — unit', () => {
  it('is idempotent per checkout: a retried createOrder does not debit again', async () => {
    const gc: any = { findOneAndUpdate: jest.fn() };
    const tx: any = { exists: jest.fn().mockResolvedValue({ _id: 'x' }), create: jest.fn() };
    const { svc } = build(gc, tx);
    await svc.redeemAtOrderPlacement('s1', 'gc1', 20, 'chk1', 'o1');
    expect(gc.findOneAndUpdate).not.toHaveBeenCalled();
    expect(tx.create).not.toHaveBeenCalled();
  });

  it('records only what was really taken and raises an alert for the shortfall', async () => {
    const gc: any = { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'g1', balance: 30 }) }; // 'before' doc: only 30 left, 50 wanted
    const tx: any = { exists: jest.fn().mockResolvedValue(null), create: jest.fn() };
    const { svc, activity } = build(gc, tx);
    await svc.redeemAtOrderPlacement('s1', 'gc1', 50, 'chk1', 'o1');
    expect(tx.create).toHaveBeenCalledWith(expect.objectContaining({ amount: -30, balanceAfter: 0 }));
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'gift_card_shortfall', isSecurityAlert: true }));
  });

  it('an already-empty card yields no debit row but still raises the alert', async () => {
    const gc: any = { findOneAndUpdate: jest.fn().mockResolvedValue(null), exists: jest.fn().mockResolvedValue(null) };
    const tx: any = { exists: jest.fn().mockResolvedValue(null), create: jest.fn() };
    const { svc, activity } = build(gc, tx);
    await svc.redeemAtOrderPlacement('s1', 'gc1', 50, 'chk1', 'o1');
    expect(tx.create).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'gift_card_shortfall' }));
  });

  it('a concurrent retry that lost the race (checkout already debited) is silent, not a shortfall', async () => {
    const gc: any = { findOneAndUpdate: jest.fn().mockResolvedValue(null), exists: jest.fn().mockResolvedValue({ _id: 'g1' }) };
    const tx: any = { exists: jest.fn().mockResolvedValue(null), create: jest.fn() };
    const { svc, activity } = build(gc, tx);
    await svc.redeemAtOrderPlacement('s1', 'gc1', 50, 'chk1', 'o1');
    expect(activity.log).not.toHaveBeenCalled();
    expect(tx.create).not.toHaveBeenCalled();
  });
});

const URI = process.env.TEST_MONGO_URI ?? process.env.TEST_MONGO_REPLSET_URI;
(URI ? describe : describe.skip)('GiftCardsService.redeemAtOrderPlacement — real MongoDB', () => {
  let conn: mongoose.Connection, GC: mongoose.Model<any>, TX: mongoose.Model<any>, svc: GiftCardsService, activity: any;
  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!).asPromise();
    GC = conn.model('GiftCard', GiftCardSchema);
    TX = conn.model('GiftCardTransaction', GiftCardTransactionSchema);
    ({ svc, activity } = build(GC, TX));
  });
  beforeEach(async () => { await Promise.all([GC.deleteMany({}), TX.deleteMany({})]); activity.log.mockClear(); });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const card = (balance: number) => GC.create({ storeId: 's1', code: 'GC-TEST', currency: 'USD', initialValue: balance, balance, issuedBy: 'manual' });

  it('two checkouts spending the same 50 card each with a 50 discount debit exactly 50 in total', async () => {
    await card(50);
    await Promise.all([svc.redeemAtOrderPlacement('s1', 'GC-TEST', 50, 'chkA', 'oA'), svc.redeemAtOrderPlacement('s1', 'GC-TEST', 50, 'chkB', 'oB')]);
    const after = (await GC.findOne({ code: 'GC-TEST' }).lean()) as any;
    expect(after.balance).toBe(0); // never negative
    const debits = (await TX.find({ type: 'redeem' }).lean()) as any[];
    expect(debits.reduce((s, t) => s + t.amount, 0)).toBe(-50); // ledger == what actually left the card
    expect(activity.log.mock.calls.filter((c: any[]) => c[0].action === 'gift_card_shortfall')).toHaveLength(1);
  });

  it('a retried placement for the same checkout debits once', async () => {
    await card(100);
    await Promise.all([1, 2, 3].map(() => svc.redeemAtOrderPlacement('s1', 'GC-TEST', 40, 'chkA', 'oA')));
    expect(((await GC.findOne({ code: 'GC-TEST' }).lean()) as any).balance).toBe(60);
  });
});
