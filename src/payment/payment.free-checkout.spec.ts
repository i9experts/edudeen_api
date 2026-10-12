/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const freeItem = (over: any = {}) => ({
  productId: 'p1',
  variantId: 'v1',
  storeId: 'A',
  sellerId: 'sa',
  type: 'digital',
  name: 'Free worksheet',
  quantity: 1,
  price: 0,
  totalPrice: 0,
  originalPrice: null,
  currency: 'PKR',
  ...over,
});

interface Opts {
  items?: any[];
  checkout?: any;
  livePrice?: number;
  storeActive?: boolean;
  placedToday?: number;
  cap?: string;
}

function makeService(o: Opts = {}) {
  const checkout: any = {
    _id: 'c1',
    userId: 'u1',
    status: 'pending',
    expiredAt: null,
    currency: 'PKR',
    totalAmount: 0,
    shippingFee: 0,
    fxSnapshots: [{ currency: 'PKR', ratePerUSD: 280 }],
    orderPlacementStartedAt: null,
    items: o.items ?? [freeItem()],
    ...o.checkout,
  };
  const checkoutModel: any = {
    findOne: jest.fn(async () => ({ ...checkout })),
    // atomic claim, like Mongo's findOneAndUpdate on the marker field
    findOneAndUpdate: jest.fn(async (filter: any) => {
      if (
        checkout.orderPlacementStartedAt !== null ||
        !filter.status.$in.includes(checkout.status)
      )
        return null;
      checkout.orderPlacementStartedAt = new Date();
      return { ...checkout };
    }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn(async (_f: any, u: any) => {
      if (u.$set?.orderPlacementStartedAt === null)
        checkout.orderPlacementStartedAt = null;
      return {};
    }),
  };
  const repos: any = {
    checkoutModel,
    storeModel: {
      find: jest.fn(() => ({
        select: () => ({
          lean: async () =>
            o.storeActive === false ? [] : [{ _id: 'A' }, { _id: 'B' }],
        }),
      })),
    },
    productVariantModel: {
      findOne: jest.fn(async () => ({
        price: o.livePrice ?? 0,
        unlimitedStock: true,
        stock: 0,
      })),
    },
    paymentTransactionModel: {
      create: jest.fn().mockResolvedValue({}),
      countDocuments: jest.fn(async () => o.placedToday ?? 0),
    },
    orderModel: {},
    addressModel: {},
    cartModel: {},
  };
  const config: any = {
    get: jest.fn((k: string) =>
      k === 'FREE_ORDERS_PER_USER_PER_DAY' ? o.cap : undefined,
    ),
  };
  const svc: any = new PaymentService(
    { repositories: repos } as any,
    {} as any,
    config,
    {} as any,
    {} as any,
    {} as any,
    new ExchangeRateService({} as any, {} as any, {} as any),
    { log: jest.fn() } as any,
    { findRedeemable: jest.fn() } as any,
    {} as any,
    {} as any,
  );
  svc.createOrder = jest.fn(async () => [{ _id: 'o1' }]);
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  svc.formatOrder = jest.fn((x) => x);
  return { svc, repos, checkout };
}
const free = (s: any, body: any = { checkoutId: 'c1' }) =>
  s.freeCheckout('u1', body);

describe('free checkout — a 0 grand total needs no payment', () => {
  it('places the orders already paid (paymentType "free"), records a 0 transaction, and cleans the cart', async () => {
    const { svc, repos } = makeService();
    const res = await free(svc);
    expect(res.data.orders).toHaveLength(1);
    const [, , , , physicalPayment, digitalPayment] =
      svc.createOrder.mock.calls[0];
    expect(physicalPayment).toEqual({ paymentType: 'free', isPaid: true });
    expect(digitalPayment).toEqual({ paymentType: 'free', isPaid: true });
    expect(repos.paymentTransactionModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentType: 'free',
        amount: 0,
        status: 'completed',
        stripePaymentIntentId: null,
      }),
    );
    expect(repos.checkoutModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', {
      status: 'completed',
    });
    expect(svc.removeCheckedOutItemsFromCart).toHaveBeenCalledTimes(1);
  });

  it('the server decides: a stored total above 0 is refused, whatever the client says', async () => {
    const { svc } = makeService({
      checkout: { totalAmount: 5 },
      items: [freeItem({ totalPrice: 5 })],
    });
    await expect(
      free(svc, { checkoutId: 'c1', totalAmount: 0, free: true }),
    ).rejects.toThrow(/not free/);
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('re-prices from the lines: a corrupted stored total of 0 over priced lines is still refused', async () => {
    const { svc } = makeService({
      checkout: { totalAmount: 0 },
      items: [freeItem({ price: 100, totalPrice: 100 })],
    });
    await expect(free(svc)).rejects.toThrow(/not free/);
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('a physical item with shipping to pay never qualifies', async () => {
    const { svc } = makeService({
      items: [freeItem({ type: 'physical' })],
      checkout: { shippingFee: 300, totalAmount: 300 },
    });
    await expect(free(svc)).rejects.toThrow(/not free/);
  });

  it('a seller who raises the price after the checkout was created cannot be gotten at the old free price', async () => {
    const { svc } = makeService({ livePrice: 10 });
    await expect(free(svc)).rejects.toThrow(
      /price of "Free worksheet" has changed/,
    );
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('a discounted-to-zero item is judged against its list price, not its discounted price', async () => {
    const discounted = freeItem({ price: 0, originalPrice: 100 });
    const ok = makeService({ items: [discounted], livePrice: 100 });
    await expect(free(ok.svc)).resolves.toBeDefined();
    const raised = makeService({ items: [discounted], livePrice: 150 });
    await expect(free(raised.svc)).rejects.toThrow(/has changed/);
  });

  it("refuses when the seller's store is no longer active", async () => {
    const { svc } = makeService({ storeActive: false });
    await expect(free(svc)).rejects.toThrow(/store is not active/);
  });

  it('caps free orders per buyer per day (default 20, configurable)', async () => {
    const atCap = makeService({ placedToday: 20 });
    await expect(free(atCap.svc)).rejects.toThrow(/limit of 20 free orders/);
    const below = makeService({ placedToday: 19 });
    await expect(free(below.svc)).resolves.toBeDefined();
    const custom = makeService({ placedToday: 3, cap: '3' });
    await expect(free(custom.svc)).rejects.toThrow(/limit of 3 free orders/);
  });

  it('REPLAY / CONCURRENCY: two confirmations of one checkout create the orders exactly once', async () => {
    const { svc } = makeService();
    const results = await Promise.allSettled([free(svc), free(svc), free(svc)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(
      (x) => x.status === 'rejected',
    ) as PromiseRejectedResult[])
      expect(r.reason).toBeInstanceOf(ConflictException);
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when order creation fails, so the buyer can retry', async () => {
    const { svc, checkout } = makeService();
    svc.createOrder.mockRejectedValueOnce(new Error('db down'));
    await expect(free(svc)).rejects.toThrow('db down');
    expect(checkout.orderPlacementStartedAt).toBeNull();
    await expect(free(svc)).resolves.toBeDefined();
  });
});

describe('the paid paths refuse a 0 total with a pointer to the free path', () => {
  it('initiatePayment (Stripe rejects a 0 amount) says the order is free', async () => {
    const { svc } = makeService();
    svc.assertStripeConfigured = jest.fn(() => ({}));
    await expect(
      svc.initiatePayment('u1', { checkoutId: 'c1' }),
    ).rejects.toThrow(/free/);
    await expect(
      svc.initiatePayment('u1', { checkoutId: 'c1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
