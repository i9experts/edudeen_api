/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { RatingService } from './rating.service';
import { OrdersService } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import {
  isVerifiedPurchaseLine,
  checkVerifiedPurchase,
} from './verified-purchase.util';

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
const orderWith = (item: any, isPaid: boolean) => ({
  _id: id('order-1'),
  userId: 'u1',
  checkoutId: 'chk',
  orderNumber: 'ORD-1',
  isPaid,
  paymentType: 'stripe',
  isDelete: false,
  sellerOrders: [
    {
      _id: id('so-1'),
      storeId: 'S',
      sellerId: 'sel',
      fulfillmentType: item.type,
      status: 'pending',
      subtotal: 10,
      items: [
        {
          _id: id('i1'),
          productId: 'p1',
          variantId: 'v1',
          name: 'X',
          quantity: 1,
          price: 10,
          totalPrice: 10,
          ...item,
        },
      ],
    },
  ],
});

const MATRIX: {
  type: 'physical' | 'digital';
  status: string;
  isPaid: boolean;
}[] = [];
for (const type of ['physical', 'digital'] as const)
  for (const status of [
    'pending',
    'processing',
    'shipped',
    'delivered',
    'completed',
    'cancelled',
    'refunded',
  ])
    for (const isPaid of [true, false]) MATRIX.push({ type, status, isPaid });

describe('canReview is exactly the rule RatingService.addReview enforces', () => {
  it("every (type, item status, paid) combination: the order-view flag, the product-detail flag and addReview's check all agree", async () => {
    for (const c of MATRIX) {
      const order = orderWith({ type: c.type, status: c.status }, c.isPaid);

      // the rule that gates writing a review
      const ratingSvc: any = new RatingService(
        { repositories: { orderModel: { find: () => chain([order]) } } } as any,
        {} as any,
      );
      const accepted = await ratingSvc.checkVerifiedPurchase(
        'u1',
        'p1',
        null,
        'order-1',
      );

      // 1) the line-level flag on a buyer's order
      const ordersSvc = new OrdersService(
        {
          repositories: {
            orderModel: {
              countDocuments: async () => 1,
              find: () => chain([order]),
              findOne: () => chain(order),
            },
            sellerModel: { find: () => chain([]) },
          },
        } as any,
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
      const list = await ordersSvc.getOrdersByUserId('u1', {});
      const byId = await ordersSvc.getOrderById('u1', 'order-1');
      const fromList = list.data.orders[0].stores[0].items[0].canReview;
      const fromById = (byId.data as any).sellerOrders[0].items[0].canReview;

      // 2) the shared function used by product detail
      const fromUtil = await checkVerifiedPurchase(
        { find: () => chain([order]) },
        'u1',
        'p1',
        null,
      );

      const label = JSON.stringify(c);
      expect([label, fromList]).toEqual([label, accepted]);
      expect([label, fromById]).toEqual([label, accepted]);
      expect([label, fromUtil]).toEqual([label, accepted]);
      expect([
        label,
        isVerifiedPurchaseLine(order, order.sellerOrders[0].items[0]),
      ]).toEqual([label, accepted]);
    }
  });

  it('spot checks: paid digital (status pending) can review; unpaid digital, refunded digital and shipped-but-undelivered physical cannot', () => {
    expect(
      isVerifiedPurchaseLine(
        { isPaid: true },
        { type: 'digital', status: 'pending' },
      ),
    ).toBe(true);
    expect(
      isVerifiedPurchaseLine(
        { isPaid: false },
        { type: 'digital', status: 'pending' },
      ),
    ).toBe(false);
    expect(
      isVerifiedPurchaseLine(
        { isPaid: true },
        { type: 'digital', status: 'refunded' },
      ),
    ).toBe(false);
    expect(
      isVerifiedPurchaseLine(
        { isPaid: true },
        { type: 'physical', status: 'shipped' },
      ),
    ).toBe(false);
    expect(
      isVerifiedPurchaseLine(
        { isPaid: true },
        { type: 'physical', status: 'delivered' },
      ),
    ).toBe(true);
  });

  it('the order list answers it without any extra query per product (only the existing order + seller lookups)', async () => {
    const orders = [
      orderWith({ type: 'digital', status: 'pending' }, true),
      {
        ...orderWith({ type: 'physical', status: 'delivered' }, true),
        _id: id('order-2'),
      },
    ];
    const orderModel: any = {
      countDocuments: async () => 2,
      find: jest.fn(() => chain(orders)),
    };
    const sellerModel: any = { find: jest.fn(() => chain([])) };
    const svc = new OrdersService(
      { repositories: { orderModel, sellerModel } } as any,
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
    await svc.getOrdersByUserId('u1', {});
    expect(orderModel.find).toHaveBeenCalledTimes(1);
    expect(sellerModel.find).toHaveBeenCalledTimes(1);
  });
});

describe('product detail canReview', () => {
  function productsSvc(orders: any[], reviewed = false) {
    const orderModel: any = { find: jest.fn(() => chain(orders)) };
    const ratingModel: any = {
      exists: jest.fn(async () => (reviewed ? { _id: 'r1' } : null)),
    };
    const repos: any = {
      orderModel,
      ratingModel,
      productModel: {
        findOne: () =>
          chain({ _id: id('p1'), sellerId: 's', storeId: 'S', name: 'X' }),
      },
      productVariantModel: { find: () => chain([]) },
      sellerModel: {
        findOne: () => chain({ name: 'Seller', isVerified: true }),
      },
      storeModel: {
        findOne: () => chain({ slug: 's', name: 'S', status: 'active' }),
      },
    };
    const svc: any = Object.create(ProductsService.prototype);
    Object.assign(svc, {
      databaseService: { repositories: repos },
      subscriptionBenefits: { getActiveBenefits: async () => null },
      isHiddenByEarlyAccess: async () => false,
      isStoreLive: async () => true,
      attachCampaignBadges: async (x: any[]) => x,
      sanitizeDigitalForPublicView: (x: any) => x,
      applySubscriberPricing: (v: any[]) => v,
    });
    return { svc, orderModel, ratingModel };
  }

  it('is present and true for a buyer who bought it, false for one who did not, and absent for an anonymous visitor', async () => {
    const bought = productsSvc([
      orderWith({ type: 'digital', status: 'pending' }, true),
    ]);
    expect((await bought.svc.getProductById('p1', 'u1')).data.canReview).toBe(
      true,
    );
    const didNot = productsSvc([]);
    expect((await didNot.svc.getProductById('p1', 'u2')).data.canReview).toBe(
      false,
    );
    const anon = productsSvc([
      orderWith({ type: 'digital', status: 'pending' }, true),
    ]);
    const res = await anon.svc.getProductById('p1', null);
    expect('canReview' in res.data).toBe(false);
    expect(anon.orderModel.find).not.toHaveBeenCalled(); // no query at all without a buyer token
  });

  it('asks the database once per detail request, narrowed to the buyer and this product', async () => {
    const ctx = productsSvc([]);
    await ctx.svc.getProductById('p1', 'u1');
    expect(ctx.orderModel.find).toHaveBeenCalledTimes(1);
    expect(ctx.orderModel.find.mock.calls[0][0]).toMatchObject({
      userId: 'u1',
      'sellerOrders.items.productId': 'p1',
    });
  });

  it('hasReviewed: true once this buyer has a review of the product, false before; absent without a token; one query, same filter as addReview', async () => {
    const done = productsSvc(
      [orderWith({ type: 'digital', status: 'pending' }, true)],
      true,
    );
    const res = (await done.svc.getProductById('p1', 'u1')).data;
    expect(res).toMatchObject({ canReview: true, hasReviewed: true });
    expect(done.ratingModel.exists).toHaveBeenCalledTimes(1);
    expect(done.ratingModel.exists).toHaveBeenCalledWith({
      userId: 'u1',
      productId: 'p1',
      isDelete: false,
    });

    const fresh = productsSvc(
      [orderWith({ type: 'digital', status: 'pending' }, true)],
      false,
    );
    expect((await fresh.svc.getProductById('p1', 'u1')).data).toMatchObject({
      canReview: true,
      hasReviewed: false,
    });

    const anon = productsSvc([], true);
    const anonRes = (await anon.svc.getProductById('p1', null)).data;
    expect('hasReviewed' in anonRes).toBe(false);
    expect('canReview' in anonRes).toBe(false);
    expect(anon.ratingModel.exists).not.toHaveBeenCalled();
  });
});
