/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { NotFoundException } from '@nestjs/common';
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
