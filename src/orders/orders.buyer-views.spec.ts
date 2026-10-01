/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OrdersService } from './orders.service';

const chain = (v: any) => {
  const c: any = {
    sort: () => c,
    skip: () => c,
    limit: () => c,
    select: () => c,
    lean: () => Promise.resolve(v),
    then: (r: any, j: any) => Promise.resolve(v).then(r, j),
  };
  return c;
};
const id = (v: string) => ({ toString: () => v });

const item = (n: string, over: any = {}) => ({
  _id: id(`item-${n}`),
  productId: `p-${n}`,
  variantId: `v-${n}`,
  name: `Item ${n}`,
  type: 'physical',
  quantity: 1,
  price: 10,
  totalPrice: 10,
  status: 'pending',
  ...over,
});
const so = (storeId: string, over: any = {}) => ({
  _id: id(`so-${storeId}`),
  storeId,
  sellerId: `seller-${storeId}`,
  fulfillmentType: 'physical',
  status: 'pending',
  subtotal: 10,
  items: [item(storeId)],
  tracking: null,
  ...over,
});
const order = (n: string, over: any = {}) => ({
  _id: id(`order-${n}`),
  userId: 'buyer1',
  checkoutId: 'chk1',
  orderNumber: `ORD-${n}`,
  isPaid: true,
  paymentType: 'stripe',
  totalAmount: 20,
  currency: 'USD',
  sellerOrders: [so('A')],
  ...over,
});

function build(orders: any[], opts: { storeIds?: string[] } = {}) {
  const orderModel: any = {
    countDocuments: jest.fn(async () => orders.length),
    find: jest.fn((f: any) =>
      chain(
        orders.filter(
          (o) =>
            o.userId === f.userId &&
            (f.checkoutId === undefined || o.checkoutId === f.checkoutId),
        ),
      ),
    ),
    findOne: jest.fn(() => chain(orders[0] ?? null)),
  };
  const sellerModel: any = { find: jest.fn(() => chain([])) };
  const userModel: any = {
    findOne: jest.fn(() => chain({ name: 'Buyer', email: 'b@x.test' })),
  };
  const storeModel: any = {
    find: jest.fn(() =>
      chain((opts.storeIds ?? ['A']).map((_id) => ({ _id }))),
    ),
    findOne: jest.fn(async () => ({ _id: 'A' })),
  };
  const svc = new OrdersService(
    { repositories: { orderModel, sellerModel, userModel, storeModel } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { svc, orderModel };
}

describe('buyer order views — fulfillment mode and per-store shipping (additive)', () => {
  it('my-orders: each store entry carries fulfillmentMode (missing → "seller"), its own shippingFee, and the existing tracking fields', async () => {
    const tracking = { carrier: 'TCS', trackingNumber: '123' };
    const { svc } = build([
      order('1', {
        sellerOrders: [
          so('A', {
            fulfillmentMode: 'platform',
            shippingFee: 3,
            tracking,
            shippedAt: 'T1',
          }),
          so('B', { shippingFee: 2 }),
          so('C', { fulfillmentType: 'digital' }),
        ],
      }),
    ]);
    const { data } = await svc.getOrdersByUserId('buyer1', {});
    const stores = data.orders[0].stores;
    expect(
      stores.map((s: any) => [s.storeId, s.fulfillmentMode, s.shippingFee]),
    ).toEqual([
      ['A', 'platform', 3],
      ['B', 'seller', 2],
      ['C', 'seller', 0],
    ]);
    expect(stores[0].tracking).toEqual(tracking);
    expect(stores[0].shippedAt).toBe('T1');
  });

  it('GET /orders/:id: the same two fields are normalised on every sellerOrder, everything else is untouched', async () => {
    const { svc } = build([
      order('1', {
        sellerOrders: [
          so('A', { fulfillmentMode: 'platform', shippingFee: 3 }),
          so('B'),
        ],
      }),
    ]);
    const { data } = await svc.getOrderById('buyer1', 'order-1');
    expect(
      data.sellerOrders.map((s: any) => [
        s.storeId,
        s.fulfillmentMode,
        s.shippingFee,
      ]),
    ).toEqual([
      ['A', 'platform', 3],
      ['B', 'seller', 0],
    ]);
    expect(data.sellerOrders[0].tracking).toBeNull();
    expect(data.orderNumber).toBe('ORD-1');
  });
});

describe('seller order list rows', () => {
  it('carry fulfillmentMode of THEIR sub-order (missing → "seller"), so the app need not infer it from a 403', async () => {
    const orders = [
      order('1', {
        sellerOrders: [so('A', { fulfillmentMode: 'platform' }), so('B')],
      }),
      order('2', { sellerOrders: [so('A')] }),
    ];
    const orderModel: any = {
      countDocuments: jest.fn(async () => orders.length),
      find: jest.fn(() => chain(orders)),
    };
    const repos: any = {
      orderModel,
      storeModel: { findOne: jest.fn(async () => ({ _id: 'A' })) },
      userModel: {
        findOne: jest.fn(() => chain({ name: 'Buyer', email: 'b@x.test' })),
      },
    };
    const svc = new OrdersService(
      { repositories: repos } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const { data } = await svc.getSellerOrders('seller-A', 'A', {});
    expect(
      data.orders.map((r: any) => [r.orderNumber, r.fulfillmentMode]),
    ).toEqual([
      ['ORD-1', 'platform'],
      ['ORD-2', 'seller'],
    ]);
    // existing columns are unchanged
    expect(data.orders[0]).toMatchObject({
      type: 'physical',
      status: 'pending',
      amount: 10,
      currency: 'USD',
    });
  });
});

describe('GET /api/orders/by-checkout/:checkoutId', () => {
  const digital = order('D', {
    checkoutId: 'chk1',
    sellerOrders: [so('A', { fulfillmentType: 'digital' })],
  });
  const physical = order('P', {
    checkoutId: 'chk1',
    sellerOrders: [so('B', { shippingFee: 2 }), so('C', { shippingFee: 2 })],
  });
  const CHK = '64f0c0ffee0c0ffee0c0ff01';
  const inCheckout = (o: any) => ({ ...o, checkoutId: CHK });

  it('returns every Order the checkout produced (digital + physical) in the same shape as my-orders', async () => {
    const { svc } = build([inCheckout(digital), inCheckout(physical)]);
    const res = await svc.getOrdersByCheckout('buyer1', CHK);
    expect(res.data.orders.map((o: any) => o.orderNumber)).toEqual([
      'ORD-D',
      'ORD-P',
    ]);
    expect(res.data.orders[1].stores).toHaveLength(2);
    // identical per-order shape to my-orders
    const mine = await build([
      inCheckout(digital),
      inCheckout(physical),
    ]).svc.getOrdersByUserId('buyer1', {});
    expect(res.data.orders).toEqual(mine.data.orders);
    expect(res.data.pagination).toMatchObject({ total: 2, page: 1 });
  });

  it("another buyer's checkout, an unknown one and a malformed id are all the same 404", async () => {
    const { svc } = build([inCheckout(physical)]);
    await expect(
      svc.getOrdersByCheckout('someone-else', CHK),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.getOrdersByCheckout('buyer1', '64f0c0ffee0c0ffee0c0ff99'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.getOrdersByCheckout('buyer1', 'not-an-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is declared before the catch-all GET /:orderId, which would otherwise swallow it', () => {
    const src = readFileSync(join(__dirname, 'orders.controller.ts'), 'utf8');
    expect(src.indexOf("@Get('by-checkout/:checkoutId')")).toBeGreaterThan(-1);
    expect(src.indexOf("@Get('by-checkout/:checkoutId')")).toBeLessThan(
      src.indexOf("@Get(':orderId')"),
    );
  });
});
