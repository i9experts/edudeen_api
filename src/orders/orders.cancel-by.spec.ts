/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const id = (v: string) => ({ toString: () => v });
const item = (n: string, totalPrice: number) => ({ _id: id(n), name: n, type: 'physical', variantId: `v-${n}`, quantity: 1, status: 'pending', totalPrice });

/** Unpaid COD order, two stores: A (a1) and B (b1). */
function build(ownsStore = true) {
  const order: any = {
    _id: 'order-1', userId: 'buyer-1', isPaid: false, paymentType: 'cash_on_delivery', orderStatus: 'pending',
    sellerOrders: [
      { storeId: 'A', sellerId: 'sa', status: 'pending', shippingFee: 0, items: [item('a1', 1000)] },
      { storeId: 'B', sellerId: 'sb', status: 'pending', shippingFee: 0, items: [item('b1', 2000)] },
    ],
  };
  const repos: any = {
    orderModel: { findOne: jest.fn().mockResolvedValue(order), findByIdAndUpdate: jest.fn().mockResolvedValue({}) },
    productVariantModel: { updateOne: jest.fn().mockResolvedValue({}) },
    storeModel: { findOne: jest.fn().mockReturnValue({ select: () => ({ lean: async () => (ownsStore ? { _id: 'A' } : null) }) }) },
  };
  const activity = { log: jest.fn().mockResolvedValue(true) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const payment: any = { refundStripePaymentIntent: jest.fn(), restoreGiftCardForItems: jest.fn().mockResolvedValue(undefined) };
  const svc = new OrdersService({ repositories: repos } as any, {} as any, {} as any, {} as any, {} as any, activity as any, {} as any, notifications as any, payment, {} as any);
  return { svc, repos, order, activity, notifications };
}
const setOf = (repos: any) => repos.orderModel.findByIdAndUpdate.mock.calls[0][1].$set;

describe('cancelledBy is written with the cancel', () => {
  it('buyer cancel -> buyer, seller is notified', async () => {
    const { svc, repos, notifications } = build();
    await svc.cancelOrder('buyer-1', 'order-1', { reason: 'changed mind', itemIds: ['a1'] });
    const s = setOf(repos);
    expect(s['sellerOrders.0.items.0.cancelledBy']).toBe('buyer');
    expect(s['sellerOrders.0.cancelledBy']).toBe('buyer');
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'sa', recipientRole: 'seller' }));
  });

  it('seller cancel -> seller, only own package, buyer notified, no admin log', async () => {
    const { svc, repos, notifications, activity } = build();
    await svc.cancelOrder('seller-1', 'order-1', { reason: 'out of stock', storeId: 'A' }, { role: 'seller' });
    const s = setOf(repos);
    expect(s['sellerOrders.0.status']).toBe('cancelled');
    expect(s['sellerOrders.0.cancelledBy']).toBe('seller');
    expect(s['sellerOrders.1.status']).toBeUndefined(); // store B untouched
    expect(s.orderStatus).toBeUndefined();
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'buyer-1', recipientRole: 'user' }));
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_cancelled_by_seller' }));
  });

  it('admin cancel -> admin, activity-log entry, whole order cancels', async () => {
    const { svc, repos, activity } = build();
    await svc.cancelOrder('admin-1', 'order-1', { reason: 'fraud check' }, { role: 'admin' });
    const s = setOf(repos);
    expect(s['sellerOrders.0.cancelledBy']).toBe('admin');
    expect(s['sellerOrders.1.cancelledBy']).toBe('admin');
    expect(s.orderStatus).toBe('cancelled');
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_cancelled_by_admin', actorRole: 'admin' }));
  });
});

describe('seller cancel is limited to their own store', () => {
  it("another seller's store is refused", async () => {
    const { svc, repos } = build(false);
    await expect(svc.cancelOrder('seller-2', 'order-1', { reason: 'x y z', storeId: 'A' }, { role: 'seller' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(repos.orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('cannot name an item of another store', async () => {
    const { svc, repos } = build();
    await expect(svc.cancelOrder('seller-1', 'order-1', { reason: 'x y z', storeId: 'A', itemIds: ['b1'] }, { role: 'seller' })).rejects.toThrow(/Item not found/);
    expect(repos.orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('a store that is not on the order gets 404', async () => {
    const { svc } = build();
    await expect(svc.cancelOrder('seller-1', 'order-1', { reason: 'x y z', storeId: 'ZZ' }, { role: 'seller' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a reason is required', async () => {
    const { svc } = build();
    await expect(svc.cancelOrder('seller-1', 'order-1', { storeId: 'A', reason: '  ' }, { role: 'seller' })).rejects.toThrow(/reason/);
  });
});
