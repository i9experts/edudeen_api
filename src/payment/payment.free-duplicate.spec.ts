/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

// The real duplicate case: two TABS = two DIFFERENT checkouts of the same free product for the same buyer.
// (payment.free-checkout.spec.ts covers the one-checkout replay; this pins the per-buyer rule.)
const line = () => ({
  productId: 'p1', variantId: 'v1', storeId: 'A', sellerId: 'sa', type: 'digital', name: 'Free worksheet',
  quantity: 1, price: 0, totalPrice: 0, originalPrice: null, currency: 'PKR',
});

function makeService() {
  const checkouts: Record<string, any> = {};
  for (const id of ['c1', 'c2', 'c3']) {
    checkouts[id] = {
      _id: id, userId: 'u1', status: 'pending', expiredAt: null, currency: 'PKR', totalAmount: 0, shippingFee: 0,
      fxSnapshots: [{ currency: 'PKR', ratePerUSD: 280 }], orderPlacementStartedAt: null, items: [line()],
    };
  }
  // Orders that exist, per buyer: filled only when createOrder finishes (like a real insert).
  const placed: { userId: string; productId: string }[] = [];
  const checkoutModel: any = {
    findOne: jest.fn(async (f: any) => {
      const c = checkouts[f._id];
      return c && c.userId === f.userId ? { ...c } : null;
    }),
    findOneAndUpdate: jest.fn(async (f: any) => {
      const c = checkouts[f._id];
      if (!c || c.orderPlacementStartedAt !== null || !f.status.$in.includes(c.status)) return null;
      c.orderPlacementStartedAt = new Date();
      return { ...c };
    }),
    findByIdAndUpdate: jest.fn(async (id: string, u: any) => { if (u.status) checkouts[id].status = u.status; return {}; }),
    updateOne: jest.fn(async () => ({})),
  };
  const repos: any = {
    checkoutModel,
    storeModel: { find: jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'A' }] }) })) },
    productVariantModel: { findOne: jest.fn(async () => ({ price: 0, unlimitedStock: true, stock: 0 })) },
    paymentTransactionModel: { create: jest.fn().mockResolvedValue({}), countDocuments: jest.fn(async () => 0) },
    orderModel: {
      updateMany: jest.fn().mockResolvedValue({}),
      find: jest.fn((f: any) => ({
        select: () => ({
          lean: async () => placed
            .filter((p) => p.userId === f.userId && (f['sellerOrders.items.productId'].$in as string[]).includes(p.productId))
            .map((p) => ({ sellerOrders: [{ items: [{ productId: p.productId }] }] })),
        }),
      })),
    },
    addressModel: {}, cartModel: {},
  };
  const svc: any = new PaymentService(
    { repositories: repos } as any, {} as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any,
    new ExchangeRateService({} as any, {} as any, {} as any), { log: jest.fn() } as any, { findRedeemable: jest.fn() } as any, {} as any, {} as any,
  );
  svc.createOrder = jest.fn(async (userId: string, checkout: any) => {
    await new Promise((r) => setTimeout(r, 10)); // the insert takes a moment
    for (const it of checkout.items) placed.push({ userId, productId: it.productId });
    return [{ _id: `o-${placed.length}` }];
  });
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  svc.formatOrder = jest.fn((x) => x);
  return { svc, checkouts, placed };
}

describe('free enrolment: one buyer, one product, one order', () => {
  it('two parallel requests on two DIFFERENT checkouts (two tabs) create exactly one order', async () => {
    const { svc, placed } = makeService();
    const results = await Promise.allSettled([svc.freeCheckout('u1', { checkoutId: 'c1' }), svc.freeCheckout('u1', { checkoutId: 'c2' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BadRequestException);
    expect(String(rejected.reason.message)).toMatch(/You already have "Free worksheet"/);
  });

  it('three parallel requests still give exactly one order', async () => {
    const { svc, placed } = makeService();
    const results = await Promise.allSettled(['c1', 'c2', 'c3'].map((checkoutId) => svc.freeCheckout('u1', { checkoutId })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(placed).toHaveLength(1);
  });

  it('a request AFTER ownership is rejected with a clear message and places nothing', async () => {
    const { svc, placed } = makeService();
    await svc.freeCheckout('u1', { checkoutId: 'c1' });
    expect(placed).toHaveLength(1);
    await expect(svc.freeCheckout('u1', { checkoutId: 'c2' })).rejects.toThrow('You already have "Free worksheet" - find it in your Library.');
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it('a failed first attempt does not block a later retry', async () => {
    const { svc, placed } = makeService();
    svc.createOrder.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.freeCheckout('u1', { checkoutId: 'c1' })).rejects.toThrow('db down');
    await expect(svc.freeCheckout('u1', { checkoutId: 'c2' })).resolves.toBeDefined();
    expect(placed).toHaveLength(1);
  });
});
