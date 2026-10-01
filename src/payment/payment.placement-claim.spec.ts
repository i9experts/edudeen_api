/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { ConflictException } from '@nestjs/common';
import { PaymentService } from './payment.service';

// Simulates Mongo's atomic findOneAndUpdate on the checkout's claim marker:
// the first caller flips orderPlacementStartedAt, every later caller matches nothing.
function makeService(
  createOrderImpl?: () => Promise<any[]>,
  giftCardsService: any = {},
  checkoutExtra: any = {},
) {
  const checkout: any = {
    _id: 'c1',
    userId: 'u1',
    status: 'pending',
    expiredAt: null,
    currency: 'USD',
    totalAmount: 50,
    orderPlacementStartedAt: null,
    fxSnapshots: [],
    ...checkoutExtra,
    items: [
      {
        type: 'physical',
        storeId: 's1',
        variantId: 'v1',
        quantity: 1,
        name: 'Book',
      },
    ],
  };
  const checkoutModel: any = {
    findOne: jest.fn().mockImplementation(async () => ({ ...checkout })),
    findOneAndUpdate: jest.fn().mockImplementation(async (filter: any) => {
      if (
        checkout.orderPlacementStartedAt !== null ||
        !filter.status.$in.includes(checkout.status)
      )
        return null;
      checkout.orderPlacementStartedAt = new Date();
      return { ...checkout };
    }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockImplementation(async (_f: any, u: any) => {
      if (u.$set?.orderPlacementStartedAt === null)
        checkout.orderPlacementStartedAt = null;
      return {};
    }),
  };
  const repos: any = {
    checkoutModel,
    // codEnabled:false lookups find none; the "store still active" lookup finds the checkout's store
    storeModel: {
      find: jest.fn((f: any) => ({
        select: () => ({
          lean: async () => (f.codEnabled === false ? [] : [{ _id: 's1' }]),
        }),
      })),
    },
    productVariantModel: {
      findOne: jest
        .fn()
        .mockResolvedValue({ stock: 10, unlimitedStock: false }),
    },
    paymentTransactionModel: { create: jest.fn().mockResolvedValue({}) },
    orderModel: {},
    addressModel: {},
    cartModel: {},
  };
  const svc: any = new PaymentService(
    { repositories: repos } as any,
    {} as any,
    { get: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { log: jest.fn() } as any,
    giftCardsService,
    {} as any,
    {} as any,
  );
  svc.createOrder = jest
    .fn()
    .mockImplementation(createOrderImpl ?? (async () => [{ _id: 'o1' }]));
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  svc.formatOrder = jest.fn((o) => o);
  return { svc, checkout, checkoutModel };
}

describe('COD placement is claimed atomically', () => {
  it('two concurrent COD requests for one checkout place exactly one order set', async () => {
    const { svc } = makeService();
    const results = await Promise.allSettled([
      svc.codPayment('u1', { checkoutId: 'c1' }),
      svc.codPayment('u1', { checkoutId: 'c1' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when order creation fails, so the buyer can retry', async () => {
    let fail = true;
    const { svc, checkout } = makeService(async () => {
      if (fail) {
        fail = false;
        throw new Error('db down');
      }
      return [{ _id: 'o1' }];
    });
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(
      'db down',
    );
    expect(checkout.orderPlacementStartedAt).toBeNull();
    await expect(
      svc.codPayment('u1', { checkoutId: 'c1' }),
    ).resolves.toBeDefined();
    expect(svc.createOrder).toHaveBeenCalledTimes(2);
  });
});

describe('gift card balance is re-checked before an order is placed', () => {
  const withCard = {
    giftCardCode: 'GC1',
    giftCardStoreId: 's1',
    giftCardDiscountTotalUSD: 40,
  };

  it('COD is refused (and nothing placed) when the card was drained by another checkout', async () => {
    const giftCards = {
      findRedeemable: jest.fn().mockResolvedValue({ balance: 10 }),
    };
    const { svc } = makeService(undefined, giftCards, withCard);
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(
      /no longer has enough balance/,
    );
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('COD proceeds when the card still covers the discount', async () => {
    const giftCards = {
      findRedeemable: jest.fn().mockResolvedValue({ balance: 40 }),
    };
    const { svc } = makeService(undefined, giftCards, withCard);
    await expect(
      svc.codPayment('u1', { checkoutId: 'c1' }),
    ).resolves.toBeDefined();
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });
});
