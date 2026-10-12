/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { OrdersService } from './orders.service';

const id = (v: string) => ({ toString: () => v });
const item = (n: string, totalPrice: number, status = 'pending') => ({
  _id: id(n),
  name: n,
  type: 'physical',
  variantId: `v-${n}`,
  quantity: 1,
  status,
  totalPrice,
});

/** A paid Stripe physical order with two stores: A has items a1, a2 (shipping 300), B has b1 (shipping 300). */
function build(over: { legacy?: boolean; free?: boolean } = {}) {
  const order: any = {
    _id: 'order-1',
    userId: 'buyer-1',
    isPaid: true,
    paymentType: 'stripe',
    orderStatus: 'pending',
    currency: 'PKR',
    shippingFee: 600,
    sellerOrders: [
      {
        storeId: 'A',
        sellerId: 'sa',
        status: 'pending',
        shippingFee: over.legacy ? 0 : 300,
        items: [item('a1', 1000), item('a2', 500)],
      },
      {
        storeId: 'B',
        sellerId: 'sb',
        status: 'pending',
        shippingFee: over.legacy ? 0 : 300,
        items: [item('b1', 2000)],
      },
    ],
  };
  const repos: any = {
    orderModel: {
      findOne: jest.fn().mockResolvedValue(order),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    },
    productVariantModel: { updateOne: jest.fn().mockResolvedValue({}) },
    paymentTransactionModel: {
      findOne: jest.fn().mockResolvedValue({
        amount: 4600,
        amountRefunded: 0,
        stripePaymentIntentId: 'pi_1',
      }),
    },
  };
  const payment: any = {
    refundStripePaymentIntent: jest.fn().mockResolvedValue({ id: 're_1' }),
    restoreGiftCardForItems: jest.fn().mockResolvedValue(undefined),
  };
  const activity: any = { log: jest.fn() };
  const svc = new OrdersService(
    { repositories: repos } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { log: jest.fn() } as any,
    {} as any,
    {} as any,
    { notify: jest.fn().mockResolvedValue(undefined) } as any,
    payment,
    {} as any,
  );
  return { svc, payment, order, activity };
}
const refunded = (p: any) => p.refundStripePaymentIntent.mock.calls[0]?.[1];

describe("cancelOrder refunds the cancelled store's own shipping share", () => {
  it("cancelling ONE store's only item refunds that item plus that store's shipping — not the other store's", async () => {
    const { svc, payment } = build();
    await svc.cancelOrder('buyer-1', 'order-1', {
      reason: 'changed mind',
      itemIds: ['b1'],
    });
    expect(refunded(payment)).toBe(2300); // 2000 + B's 300
  });

  it("cancelling part of a store's items refunds the items only; the shipping follows when the last one goes", async () => {
    const first = build();
    await first.svc.cancelOrder('buyer-1', 'order-1', {
      reason: 'x',
      itemIds: ['a1'],
    });
    expect(refunded(first.payment)).toBe(1000); // A still ships a2 — no shipping refund yet

    const both = build();
    await both.svc.cancelOrder('buyer-1', 'order-1', {
      reason: 'x',
      itemIds: ['a1', 'a2'],
    });
    expect(refunded(both.payment)).toBe(1800); // 1500 + A's 300
  });

  it("cancelling everything refunds all items and every store's shipping", async () => {
    const { svc, payment } = build();
    await svc.cancelOrder('buyer-1', 'order-1', { reason: 'x' });
    expect(refunded(payment)).toBe(4100); // 3500 + 600 (capped by the 4600 charge)
  });

  it('REGRESSION: an order placed before per-store shipping refunds the whole flat fee only on a whole-order cancel', async () => {
    const whole = build({ legacy: true });
    await whole.svc.cancelOrder('buyer-1', 'order-1', { reason: 'x' });
    expect(refunded(whole.payment)).toBe(4100);

    const partial = build({ legacy: true });
    await partial.svc.cancelOrder('buyer-1', 'order-1', {
      reason: 'x',
      itemIds: ['b1'],
    });
    expect(refunded(partial.payment)).toBe(2000);
  });
});

describe('cancelOrder hands the cancelled items back to the gift-card restore (per sub-order, idempotent key)', () => {
  it('restores only for the sub-order and items being cancelled', async () => {
    const { svc, payment, order } = build();
    await svc.cancelOrder('buyer-1', 'order-1', {
      reason: 'x',
      itemIds: ['b1'],
    });
    expect(payment.restoreGiftCardForItems).toHaveBeenCalledTimes(1);
    const [o, so, items, key] = payment.restoreGiftCardForItems.mock.calls[0];
    expect(o).toBe(order);
    expect(so.storeId).toBe('B');
    expect(items.map((i: any) => i._id.toString())).toEqual(['b1']);
    expect(key).toBe('cancel-order-1-b1');
  });
});

describe('cancelling a FREE order', () => {
  it('moves no money (no Stripe refund, no "send the refund by hand" alert) but still cancels the items', async () => {
    const { svc, payment, activity } = build({ free: true });
    // free order: everything cost 0
    const order: any = await (
      svc as any
    ).databaseService.repositories.orderModel.findOne();
    order.sellerOrders.forEach((so: any) => {
      so.shippingFee = 0;
      so.items.forEach((i: any) => {
        i.totalPrice = 0;
      });
    });
    order.shippingFee = 0;
    const res = await svc.cancelOrder('buyer-1', 'order-1', {
      reason: 'x',
      itemIds: ['a1'],
    });
    expect(res.success).toBe(true);
    expect(payment.refundStripePaymentIntent).not.toHaveBeenCalled();
    expect(activity.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'manual_refund_required' }),
    );
  });
});
