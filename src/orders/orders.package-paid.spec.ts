/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/unbound-method -- mock-heavy tests */
import { OrdersService } from './orders.service';
import { isPackagePaid } from './package-paid.util';

const idOf = (v: string) => ({ toString: () => v });

describe('isPackagePaid', () => {
  it('order-level paid wins (single-seller / legacy orders unchanged)', () => {
    expect(isPackagePaid({ isPaid: true }, { isPaid: false })).toBe(true);
    expect(isPackagePaid({ isPaid: true }, {})).toBe(true);
  });
  it('a paid package of a partially_paid order counts as paid; an unpaid one does not', () => {
    expect(isPackagePaid({ isPaid: false }, { isPaid: true })).toBe(true);
    expect(isPackagePaid({ isPaid: false }, { isPaid: false })).toBe(false);
    expect(isPackagePaid({ isPaid: false }, {})).toBe(false);
    expect(isPackagePaid(undefined, undefined)).toBe(false);
  });
});

function buildReturn(opts: { orderPaid?: boolean; packagePaid?: boolean }) {
  const item = { _id: idOf('item-1'), name: 'Book', type: 'physical', variantId: 'v1', quantity: 1, status: 'delivered', totalPrice: 20, refundedAmount: 0, returnStatus: 'requested' };
  const order: any = {
    _id: 'order-1', orderNumber: 'ORD-1', userId: 'buyer-1', isPaid: !!opts.orderPaid, paymentStatus: opts.orderPaid ? 'paid' : 'partially_paid',
    currency: 'USD', paymentType: 'cash_on_delivery', fxSnapshots: [], hasReturnApproved: false,
    sellerOrders: [
      { storeId: 'store-1', sellerId: 'seller-1', settlementCurrency: 'USD', returnStatus: 'requested', isPaid: !!opts.packagePaid, items: [item] },
      { storeId: 'store-2', sellerId: 'seller-2', settlementCurrency: 'USD', isPaid: false, items: [] },
    ],
  };
  const orderModel: any = {
    findOne: jest.fn().mockResolvedValue(order),
    findOneAndUpdate: jest.fn().mockResolvedValue(order),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const repos: any = {
    orderModel, storeModel: { findOne: jest.fn().mockResolvedValue({ _id: 'store-1' }) },
    productVariantModel: { updateOne: jest.fn().mockResolvedValue({}) },
    paymentTransactionModel: { findOne: jest.fn().mockResolvedValue(null) },
  };
  const finance: any = { recordRefundForSellerOrder: jest.fn().mockResolvedValue(undefined) };
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  const loyalty: any = { clawbackPurchasePoints: jest.fn().mockResolvedValue(undefined) };
  const payment: any = { refundStripePaymentIntent: jest.fn(), restoreGiftCardForItems: jest.fn().mockResolvedValue(undefined) };
  const fx: any = { convertWithSnapshots: jest.fn((a: number) => a) };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const svc = new OrdersService({ repositories: repos } as any, {} as any, {} as any, {} as any, finance, activity, loyalty, notifications, payment, fx);
  return { svc, finance, activity, notifications };
}
const approve = (svc: OrdersService) => svc.returnAction('seller-1', 'order-1', { storeId: 'store-1', itemIds: ['item-1'], action: 'approve' });

describe('returnAction reads the PACKAGE paid state (multi-seller COD)', () => {
  it('a paid package of a partially_paid order is refunded (ledger refund + manual cash refund alert)', async () => {
    const { svc, finance, activity } = buildReturn({ orderPaid: false, packagePaid: true });
    const res: any = await approve(svc);
    expect(finance.recordRefundForSellerOrder).toHaveBeenCalledTimes(1);
    expect(res.data.refundProcessed).toBe(true);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'manual_refund_required' }));
  });

  it('an unpaid package of a partially_paid order triggers NO refund and no refund promise to the buyer', async () => {
    const { svc, finance, activity, notifications } = buildReturn({ orderPaid: false, packagePaid: false });
    const res: any = await approve(svc);
    expect(finance.recordRefundForSellerOrder).not.toHaveBeenCalled();
    expect(res.data.refundProcessed).toBe(false);
    expect(activity.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'manual_refund_required' }));
    expect(notifications.notify.mock.calls[0][0].body).not.toMatch(/refund is on its way/);
  });

  it('legacy / single-seller paid order (no package flag) still refunds', async () => {
    const { svc, finance } = buildReturn({ orderPaid: true, packagePaid: false });
    await approve(svc);
    expect(finance.recordRefundForSellerOrder).toHaveBeenCalledTimes(1);
  });
});

describe('markPackagePaid updates that package payment row', () => {
  it('flips only the pending COD row of the paid package to completed with paidAt', async () => {
    const order: any = {
      _id: 'order-1', orderNumber: 'ORD-1', userId: 'buyer-1', isPaid: false, paymentType: 'cash_on_delivery', orderStatus: 'partially_shipped',
      sellerOrders: ['A', 'B'].map((s) => ({ storeId: s, sellerId: `s${s}`, status: 'shipped', fulfillmentType: 'physical', fulfillmentMode: 'seller', isPaid: false, subtotal: 10, shippingFee: 2, codAmount: 12, items: [{ status: 'shipped' }] })),
    };
    const orderModel: any = {
      findOne: jest.fn().mockResolvedValue(order),
      findOneAndUpdate: jest.fn().mockResolvedValue(order),
      findById: jest.fn(() => ({ lean: () => Promise.resolve(order) })),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const paymentTransactionModel: any = { updateOne: jest.fn().mockResolvedValue({}) };
    const finance: any = { recordSaleDurable: jest.fn().mockResolvedValue({ creditStatus: 'credited' }) };
    const svc: any = new OrdersService(
      { repositories: { orderModel, storeModel: {}, paymentTransactionModel } } as any,
      {} as any, {} as any, {} as any, finance, { log: jest.fn() } as any, { awardPurchasePoints: jest.fn() } as any,
      { notify: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any,
    );
    await svc.markPaid('order-1', { userId: 'sA', role: 'seller' }, 'A');
    expect(paymentTransactionModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = paymentTransactionModel.updateOne.mock.calls[0];
    expect(filter).toMatchObject({ orderIds: 'order-1', paymentType: 'cash_on_delivery', storeId: 'A', status: 'pending' });
    expect(update.$set.status).toBe('completed');
    expect(update.$set.paidAt).toBeInstanceOf(Date);
  });
});
