/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const idOf = (v: string) => ({ toString: () => v });

function build(opts: { currency?: string; settlement?: string; paymentType?: string; itemOverrides?: any } = {}) {
  const item = { _id: idOf('item-1'), name: 'Book', type: 'physical', variantId: 'v1', quantity: 2, status: 'delivered', totalPrice: 28000, refundedAmount: 0, returnStatus: 'requested', ...opts.itemOverrides };
  const order: any = {
    _id: 'order-1', orderNumber: 'ORD-1', userId: 'buyer-1', isPaid: true, currency: opts.currency ?? 'PKR', paymentType: opts.paymentType ?? 'stripe',
    fxSnapshots: [], hasReturnApproved: false,
    sellerOrders: [{ storeId: 'store-1', sellerId: 'seller-1', settlementCurrency: opts.settlement ?? 'USD', returnStatus: 'requested', items: [item] }],
  };
  const orderModel: any = {
    findOne: jest.fn().mockResolvedValue(order),
    findOneAndUpdate: jest.fn().mockResolvedValue(order),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const variants: any = { updateOne: jest.fn().mockResolvedValue({}) };
  const repos: any = {
    orderModel, storeModel: { findOne: jest.fn().mockResolvedValue({ _id: 'store-1' }) }, productVariantModel: variants,
    paymentTransactionModel: { findOne: jest.fn().mockResolvedValue({ amount: 28000, amountRefunded: 0, stripePaymentIntentId: 'pi_1' }) },
  };
  const finance: any = { recordRefund: jest.fn().mockResolvedValue(undefined) };
  // The services now go through recordRefundForSellerOrder; for non-COD orders it is exactly recordRefund.
  finance.recordRefundForSellerOrder = jest.fn((a: any) =>
    finance.recordRefund(a.storeId, a.sellerId, a.orderId, a.sellerDebitAmount, a.actorId, a.actorRole, { description: a.description, targetType: a.targetType, currency: a.currency }),
  );
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  const loyalty: any = { clawbackPurchasePoints: jest.fn().mockResolvedValue(undefined) };
  const payment: any = { refundStripePaymentIntent: jest.fn().mockResolvedValue({ id: 're_1' }) };
  const fx: any = { convertWithSnapshots: jest.fn((amt: number, from: string, to: string) => (from === 'PKR' && to === 'USD' ? amt / 280 : amt)) };
  const svc = new OrdersService({ repositories: repos } as any, {} as any, {} as any, {} as any, finance, activity, loyalty, {} as any, {} as any, payment, fx);
  return { svc, orderModel, variants, finance, activity, payment, fx };
}
const approve = (svc: OrdersService) => svc.returnAction('seller-1', 'order-1', { storeId: 'store-1', itemIds: ['item-1'], action: 'approve' });

describe('OrdersService.returnAction (legacy return flow)', () => {
  it("debits the seller's SETTLEMENT-currency wallet using the order's FX snapshots (PKR 28000 → USD 100, not $28000)", async () => {
    const { svc, finance } = build();
    await approve(svc);
    expect(finance.recordRefund).toHaveBeenCalledWith('store-1', 'seller-1', 'order-1', 100, 'seller-1', 'seller', expect.objectContaining({ currency: 'USD' }));
  });

  it('claims the return atomically (all target items must still be "requested")', async () => {
    const { svc, orderModel } = build();
    await approve(svc);
    expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'order-1', 'sellerOrders.0.items.0.returnStatus': 'requested' }),
      { $set: expect.objectContaining({ 'sellerOrders.0.items.0.returnStatus': 'approved' }) },
    );
  });

  it('a double-click / retry that loses the claim refunds, restocks and debits NOTHING', async () => {
    const { svc, orderModel, finance, payment, variants } = build();
    orderModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(approve(svc)).rejects.toThrow(/already processed/);
    expect(payment.refundStripePaymentIntent).not.toHaveBeenCalled();
    expect(finance.recordRefund).not.toHaveBeenCalled();
    expect(variants.updateOne).not.toHaveBeenCalled();
  });

  it('if the Stripe refund fails, the claim is rolled back so the return stays pending', async () => {
    const { svc, orderModel, finance, payment } = build();
    payment.refundStripePaymentIntent.mockRejectedValue(new Error('stripe down'));
    await expect(approve(svc)).rejects.toThrow('stripe down');
    expect(orderModel.updateOne).toHaveBeenCalledWith({ _id: 'order-1' }, { $set: expect.objectContaining({ 'sellerOrders.0.items.0.returnStatus': 'requested' }) });
    expect(finance.recordRefund).not.toHaveBeenCalled();
  });

  it('refuses an item that was already refunded through another flow', async () => {
    const { svc, finance } = build({ itemOverrides: { status: 'refunded', refundedAmount: 28000 } });
    await expect(approve(svc)).rejects.toBeInstanceOf(BadRequestException);
    expect(finance.recordRefund).not.toHaveBeenCalled();
  });

  it('a failed ledger debit is reported as a security alert, not swallowed via console.error', async () => {
    const { svc, finance, activity } = build();
    finance.recordRefund.mockRejectedValue(new Error('txn aborted'));
    const res: any = await approve(svc);
    expect(res.data.refundProcessed).toBe(false);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'return_ledger_debit_failed', isSecurityAlert: true }));
  });

  it('rejecting a return moves no money', async () => {
    const { svc, finance, payment } = build();
    await svc.returnAction('seller-1', 'order-1', { storeId: 'store-1', itemIds: ['item-1'], action: 'reject', rejectReason: 'used' });
    expect(payment.refundStripePaymentIntent).not.toHaveBeenCalled();
    expect(finance.recordRefund).not.toHaveBeenCalled();
  });
});
