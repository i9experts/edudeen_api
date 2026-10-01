/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

function build(sellerOrder: any, orderOver: any = {}) {
  const order: any = {
    _id: 'order-1',
    orderNumber: 'ORD-1',
    userId: 'buyer-1',
    isPaid: false,
    paymentType: 'cash_on_delivery',
    sellerOrders: [
      {
        storeId: 'store-1',
        sellerId: 'seller-1',
        status: 'pending',
        fulfillmentType: 'physical',
        items: [{ status: 'pending' }],
        ...sellerOrder,
      },
    ],
    ...orderOver,
  };
  const orderModel: any = {
    findOne: jest.fn().mockResolvedValue(order),
    findOneAndUpdate: jest.fn().mockResolvedValue(order),
    findByIdAndUpdate: jest.fn().mockResolvedValue(order),
  };
  const storeModel: any = {
    findOne: jest.fn((f: any) =>
      Promise.resolve(
        f.sellerId && f.sellerId !== 'seller-1' ? null : { _id: 'store-1' },
      ),
    ),
  };
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const finance: any = { recordSale: jest.fn().mockResolvedValue(undefined) };
  const svc = new OrdersService(
    { repositories: { orderModel, storeModel } } as any,
    {} as any,
    {} as any,
    {} as any,
    finance,
    activity,
    { awardPurchasePoints: jest.fn() } as any,
    {
      getActiveBenefits: jest.fn().mockResolvedValue(null),
      getLoyaltyMultiplier: jest.fn(),
    } as any,
    notifications,
    {} as any,
    {} as any,
  );
  return { svc, orderModel, finance };
}

const body = (over: any = {}) => ({
  orderId: 'order-1',
  storeId: 'store-1',
  status: 'shipped',
  tracking: { carrier: 'TCS', trackingNumber: '1' },
  ...over,
});

describe('who may update a physical sub-order, by its snapshotted fulfillmentMode', () => {
  it("'seller' mode (and every pre-existing order with no mode): the seller can, an admin cannot", async () => {
    for (const mode of ['seller', undefined, null]) {
      const { svc } = build({ fulfillmentMode: mode });
      await expect(
        svc.updateSellerOrderStatus(
          'seller-1',
          body(),
          undefined,
          undefined,
          'seller',
        ),
      ).resolves.toBeDefined();
      await expect(
        svc.updateSellerOrderStatus(
          'admin-1',
          body(),
          undefined,
          undefined,
          'admin',
        ),
      ).rejects.toThrow(ForbiddenException);
    }
  });

  it("'platform' mode: the seller is refused, an admin can", async () => {
    const { svc, orderModel } = build({ fulfillmentMode: 'platform' });
    await expect(
      svc.updateSellerOrderStatus(
        'seller-1',
        body(),
        undefined,
        undefined,
        'seller',
      ),
    ).rejects.toThrow(/fulfilled by Edudeen/);
    expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    await expect(
      svc.updateSellerOrderStatus(
        'admin-1',
        body(),
        undefined,
        undefined,
        'admin',
      ),
    ).resolves.toBeDefined();
    expect(orderModel.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('a digital sub-order is always seller-managed, whatever the store mode is now', async () => {
    const { svc } = build({
      fulfillmentType: 'digital',
      fulfillmentMode: null,
    });
    await expect(
      svc.updateSellerOrderStatus(
        'seller-1',
        body({ status: 'delivered', tracking: undefined }),
        undefined,
        undefined,
        'seller',
      ),
    ).resolves.toBeDefined();
    await expect(
      svc.updateSellerOrderStatus(
        'admin-1',
        body({ status: 'delivered', tracking: undefined }),
        undefined,
        undefined,
        'admin',
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('markPaid on COD', () => {
  it('a seller can confirm cash their own courier collected, but never cash on an Edudeen-fulfilled order', async () => {
    const own = build({ fulfillmentMode: 'seller' });
    await expect(
      own.svc.markPaid('order-1', { userId: 'seller-1', role: 'seller' }),
    ).resolves.toBeDefined();

    const platform = build({ fulfillmentMode: 'platform' });
    await expect(
      platform.svc.markPaid('order-1', { userId: 'seller-1', role: 'seller' }),
    ).rejects.toThrow(/confirmed by the Edudeen team/);
    expect(platform.orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(platform.finance.recordSale).not.toHaveBeenCalled();

    await expect(
      platform.svc.markPaid('order-1', { userId: 'admin-1', role: 'admin' }),
    ).resolves.toBeDefined();
    const args = platform.finance.recordSale.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(['store-1', 'seller-1', 'order-1']);
    expect(args.slice(-3, -1)).toEqual(['cash_on_delivery', 'platform']); // payment type + the sub-order's snapshotted mode (then the shipping credit)
  });
});
