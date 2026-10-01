/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
/**
 * Gift-card balance comes back when an order paid with it is cancelled / refunded / returned.
 * Unit tests always run; the "real MongoDB" block runs only when a replica-set URI is set:
 *   TEST_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_gcr_it?replicaSet=rs0' npx jest gift-cards.restore
 */
import mongoose from 'mongoose';
import { GiftCardsService } from './gift-cards.service';
import { GiftCardSchema } from './schemas/gift-card.schema';
import { GiftCardTransactionSchema } from './schemas/gift-card-transaction.schema';
import { PaymentService, orderIdForStore } from '../payment/payment.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

describe("orderIdForStore — link a store's gift card / voucher to the Order that holds its items", () => {
  const orders = [
    { _id: 'physical-order', sellerOrders: [{ storeId: 'A' }] },
    { _id: 'digital-order', sellerOrders: [{ storeId: 'B' }] },
  ];
  it("picks the Order containing that store's sub-order, not simply the first", () => {
    expect(orderIdForStore(orders, 'B')).toBe('digital-order');
    expect(orderIdForStore(orders, 'A')).toBe('physical-order');
  });
  it('falls back to the first Order when nothing matches', () => {
    expect(orderIdForStore(orders, 'Z')).toBe('physical-order');
    expect(orderIdForStore(orders, null)).toBe('physical-order');
  });
});

describe('PaymentService.restoreGiftCardForItems', () => {
  const fx = new ExchangeRateService({} as any, {} as any, {} as any);
  function build() {
    const giftCards: any = {
      restoreBalance: jest.fn().mockResolvedValue({ restored: 1 }),
    };
    const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
    const svc: any = Object.create(PaymentService.prototype);
    Object.assign(svc, {
      giftCardsService: giftCards,
      exchangeRateService: fx,
      activityLogService: activity,
    });
    return { svc, giftCards, activity };
  }
  const snapshots = [
    { currency: 'PKR', ratePerUSD: 280 },
    { currency: 'USD', ratePerUSD: 1 },
  ];

  it("restores the gift-card share of the refunded items only, converted from the order currency into the card's store currency", async () => {
    const { svc, giftCards } = build();
    const order = {
      _id: 'o1',
      checkoutId: 'chk1',
      giftCardCode: 'GC1',
      currency: 'PKR',
      fxSnapshots: snapshots,
    };
    const sellerOrder = { storeId: 'A', settlementCurrency: 'USD' };
    await svc.restoreGiftCardForItems(
      order,
      sellerOrder,
      [{ giftCardDiscountUSD: 2800 }, { giftCardDiscountUSD: 0 }],
      'cancel-o1-x',
    );
    expect(giftCards.restoreBalance).toHaveBeenCalledWith(
      'A',
      'GC1',
      10,
      'chk1',
      'o1',
      'cancel-o1-x',
    ); // PKR 2800 → USD 10
  });

  it('does nothing for an order with no gift card, or items that carried no gift-card discount', async () => {
    const { svc, giftCards } = build();
    const so = { storeId: 'A', settlementCurrency: 'PKR' };
    await svc.restoreGiftCardForItems(
      { _id: 'o1', currency: 'PKR', fxSnapshots: snapshots },
      so,
      [{ giftCardDiscountUSD: 100 }],
      'k',
    );
    await svc.restoreGiftCardForItems(
      {
        _id: 'o1',
        giftCardCode: 'GC1',
        currency: 'PKR',
        fxSnapshots: snapshots,
      },
      so,
      [{ giftCardDiscountUSD: 0 }],
      'k',
    );
    expect(giftCards.restoreBalance).not.toHaveBeenCalled();
  });

  it("never throws once the buyer's money has moved — a failure is logged as a security alert for follow-up", async () => {
    const { svc, giftCards, activity } = build();
    giftCards.restoreBalance.mockRejectedValue(new Error('db down'));
    await expect(
      svc.restoreGiftCardForItems(
        {
          _id: 'o1',
          giftCardCode: 'GC1',
          currency: 'PKR',
          fxSnapshots: snapshots,
        },
        { storeId: 'A', settlementCurrency: 'PKR' },
        [{ giftCardDiscountUSD: 5 }],
        'k',
      ),
    ).resolves.toBeUndefined();
    expect(activity.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'gift_card_restore_failed',
        isSecurityAlert: true,
      }),
    );
  });
});

const URI = process.env.TEST_MONGO_URI ?? process.env.TEST_MONGO_REPLSET_URI;
if (URI && !/(_it|test)/i.test(new URL(URI).pathname))
  throw new Error(
    'Refusing to run: the test database name must contain "_it" or "test"',
  );
(URI ? describe : describe.skip)(
  'GiftCardsService.restoreBalance — real MongoDB',
  () => {
    let conn: mongoose.Connection,
      GC: mongoose.Model<any>,
      TX: mongoose.Model<any>,
      svc: GiftCardsService;
    beforeAll(async () => {
      conn = await mongoose.createConnection(URI!).asPromise();
      GC = conn.model('GiftCard', GiftCardSchema);
      TX = conn.model('GiftCardTransaction', GiftCardTransactionSchema);
      svc = new GiftCardsService(
        {
          repositories: { giftCardModel: GC, giftCardTransactionModel: TX },
        } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
        {} as any,
        {} as any,
        { get: jest.fn() } as any,
      );
    });
    beforeEach(async () => {
      await Promise.all([GC.deleteMany({}), TX.deleteMany({})]);
    });
    afterAll(async () => {
      await conn.dropDatabase();
      await conn.close();
    });

    const bal = async () =>
      ((await GC.findOne({ code: 'GC-TEST' }).lean()) as any).balance;
    /** A 100 card, of which checkout chk1 spent 40 (balance 60). */
    async function spent40() {
      await GC.create({
        storeId: 's1',
        code: 'GC-TEST',
        currency: 'USD',
        initialValue: 100,
        balance: 100,
        issuedBy: 'manual',
      });
      await svc.redeemAtOrderPlacement('s1', 'GC-TEST', 40, 'chk1', 'o1');
      expect(await bal()).toBe(60);
    }

    it('puts the refunded share back on the card and records a ledger row', async () => {
      await spent40();
      const res = await svc.restoreBalance(
        's1',
        'GC-TEST',
        15,
        'chk1',
        'o1',
        'cancel-1',
      );
      expect(res.restored).toBe(15);
      expect(await bal()).toBe(75);
      const row = (await TX.findOne({ type: 'refund' }).lean()) as any;
      expect(row).toMatchObject({
        amount: 15,
        balanceAfter: 75,
        checkoutId: 'chk1',
      });
    });

    it('is idempotent per refKey: 5 concurrent retries restore once', async () => {
      await spent40();
      await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          svc.restoreBalance('s1', 'GC-TEST', 15, 'chk1', 'o1', 'cancel-1'),
        ),
      );
      expect(await bal()).toBe(75);
      expect(await TX.countDocuments({ type: 'refund' })).toBe(1);
    });

    it('different cancels restore their own shares, but never more than was actually taken from the card', async () => {
      await spent40();
      await svc.restoreBalance('s1', 'GC-TEST', 25, 'chk1', 'o1', 'cancel-a');
      await svc.restoreBalance('s1', 'GC-TEST', 25, 'chk1', 'o1', 'cancel-b'); // only 15 of the 40 left to give back
      expect(await bal()).toBe(100);
      await svc.restoreBalance('s1', 'GC-TEST', 25, 'chk1', 'o1', 'cancel-c');
      expect(await bal()).toBe(100);
    });

    it("never restores for a checkout that did not spend the card, or past the card's initial value", async () => {
      await spent40();
      expect(
        (
          await svc.restoreBalance(
            's1',
            'GC-TEST',
            10,
            'other-checkout',
            'o9',
            'k',
          )
        ).restored,
      ).toBe(0);
      expect(await bal()).toBe(60);
    });

    it('restores onto a disabled card too (the value belongs to the buyer; the seller disabled further use)', async () => {
      await spent40();
      await GC.updateOne({ code: 'GC-TEST' }, { status: 'disabled' });
      await svc.restoreBalance('s1', 'GC-TEST', 10, 'chk1', 'o1', 'cancel-1');
      expect(await bal()).toBe(70);
    });
  },
);
