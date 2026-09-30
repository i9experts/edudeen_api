/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CheckoutService } from '../checkout/checkout.service';

// A PaymentIntent must never be honoured for a total the checkout no longer has.
describe('Stripe charge is bound to the checkout total', () => {
  const makePayment = (checkout: any, transaction: any) => {
    const paymentTransactionModel: any = {
      findOneAndUpdate: jest.fn().mockResolvedValue(transaction),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const checkoutModel: any = { findOne: jest.fn().mockResolvedValue(checkout) };
    const orderModel: any = { findOne: jest.fn(), create: jest.fn() };
    const db: any = { repositories: { paymentTransactionModel, checkoutModel, orderModel, addressModel: {}, cartModel: {} } };
    const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
    const fx: any = { convertWithSnapshots: jest.fn((amt: number) => amt) };
    const svc: any = new PaymentService(db, {} as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any, fx, activity, {} as any, {} as any, {} as any);
    return { svc, paymentTransactionModel, orderModel, activity };
  };

  it('refuses to create an order when the checkout total changed after the PaymentIntent was made', async () => {
    // Intent + transaction were for 70.00 (coupon applied); coupon was then removed → checkout is 100.00 again.
    const checkout = { _id: 'c1', currency: 'USD', totalAmount: 100, items: [], fxSnapshots: [] };
    const tx = { _id: 't1', checkoutId: 'c1', amount: 70, paymentScope: 'full' };
    const { svc, orderModel, activity, paymentTransactionModel } = makePayment(checkout, tx);

    await expect(svc.finalizePaymentIntent({ id: 'pi_1', amount: 7000, currency: 'usd' })).rejects.toThrow(BadRequestException);
    expect(orderModel.create).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment_amount_currency_mismatch', isSecurityAlert: true }));
    expect(paymentTransactionModel.findByIdAndUpdate).toHaveBeenCalledWith('t1', { status: 'pending', paidAt: null });
  });

  it('digital_only scope is recomputed from the digital items at finalize time', () => {
    const { svc } = makePayment({}, {});
    const checkout = {
      currency: 'USD', totalAmount: 130, fxSnapshots: [],
      items: [{ type: 'digital', totalPrice: 30, currency: 'USD' }, { type: 'physical', totalPrice: 100, currency: 'USD' }],
    };
    expect(svc.computeChargeAmount(checkout, 'digital_only')).toBe(30);
    expect(svc.computeChargeAmount(checkout, 'full')).toBe(130);
  });
});

describe('CheckoutService mutators are frozen once payment has started', () => {
  const svc = (status: string) => {
    const checkoutModel: any = { findOne: jest.fn().mockResolvedValue({ _id: 'c1', status, items: [], expiredAt: null }) };
    const db: any = { repositories: { checkoutModel, couponModel: {}, shippingZoneModel: {} } };
    return new CheckoutService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  };
  const calls: Array<[string, (s: CheckoutService) => Promise<unknown>]> = [
    ['addShippingInCheckout', (s) => s.addShippingInCheckout('u1', { checkoutId: 'c1', shippingZoneId: 'z1' })],
    ['applyCoupon', (s) => s.applyCoupon('u1', { checkoutId: 'c1', code: 'SAVE10' })],
    ['removeCoupon', (s) => s.removeCoupon('u1', { checkoutId: 'c1' })],
    ['applyGiftCard', (s) => s.applyGiftCard('u1', { checkoutId: 'c1', code: 'GC1' })],
    ['removeGiftCard', (s) => s.removeGiftCard('u1', { checkoutId: 'c1' })],
  ];
  it.each(calls)('%s rejects a payment_pending checkout', async (_name, call) => {
    await expect(call(svc('payment_pending'))).rejects.toThrow(/Payment has already been started/);
  });
});
