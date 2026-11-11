/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { CheckoutService } from './checkout.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { isBadgeLive, hasStarted, couponValueError, couponDateError } from '../marketing/coupon-rules.util';

const line = (productId: string, totalPrice: number) => ({
  storeId: 'A', productId, variantId: `v-${productId}`, type: 'digital', quantity: 1,
  price: totalPrice, totalPrice, currency: 'PKR', couponDiscountUSD: 0, giftCardDiscountUSD: 0, campaignDiscountUSD: 0,
});

function setup(c: any, priorUses = 0, priorOrders = 0) {
  const checkout: any = {
    _id: 'chk1', userId: 'u1', status: 'pending', currency: 'PKR', fxSnapshots: [{ currency: 'PKR', ratePerUSD: 280 }, { currency: 'USD', ratePerUSD: 1 }],
    expiredAt: null, shippingFee: 0, items: [line('p1', 1000), line('p2', 2000)],
  };
  const countDocuments = jest.fn(async (q: any) => (q.couponCode ? priorUses : priorOrders));
  const repos: any = {
    checkoutModel: { findOne: jest.fn().mockResolvedValue(checkout), findByIdAndUpdate: jest.fn().mockResolvedValue({}) },
    couponModel: { findOne: jest.fn().mockResolvedValue(c) },
    rewardVoucherModel: { findOne: jest.fn().mockResolvedValue(null) },
    orderModel: { countDocuments },
    categoryModel: { find: jest.fn().mockReturnValue({ select: () => ({ lean: async () => [] }) }) },
    productModel: { find: jest.fn() },
  };
  const svc = new CheckoutService({ repositories: repos } as any, {} as any, {} as any, new ExchangeRateService({} as any, {} as any, {} as any), { findRedeemable: jest.fn() } as any, {} as any);
  return { svc, checkout };
}
const coupon = (over: any = {}) => ({
  code: 'SAVE', isActive: true, isDelete: false, scope: 'seller', storeId: 'A', discountType: 'percentage', discountValue: 10,
  currency: 'PKR', usageCount: 0, usageLimit: null, expiresAt: null, minOrderAmount: null, ownerUserId: null, platformFunded: false, ...over,
});
const apply = (svc: CheckoutService) => svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' });

describe('seller coupon rules', () => {
  it('product-scoped coupon discounts only the matching product', async () => {
    const { svc, checkout } = setup(coupon({ appliesTo: 'products', targetIds: ['p2'] }));
    await apply(svc);
    expect(checkout.items.find((i: any) => i.productId === 'p2').totalPrice).toBe(1800);
    expect(checkout.items.find((i: any) => i.productId === 'p1').totalPrice).toBe(1000);
  });

  it('product-scoped coupon fails when no cart item matches', async () => {
    const { svc } = setup(coupon({ appliesTo: 'products', targetIds: ['other'] }));
    await expect(apply(svc)).rejects.toThrow("doesn't apply to the items in your cart");
  });

  it('per-customer limit 1 blocks the second use', async () => {
    const { svc } = setup(coupon({ perCustomerLimit: 1 }), 1);
    await expect(apply(svc)).rejects.toThrow('already used this coupon');
  });

  it('per-customer limit 1 allows the first use', async () => {
    const { svc } = setup(coupon({ perCustomerLimit: 1 }), 0);
    await expect(apply(svc)).resolves.toMatchObject({ success: true });
  });

  it('first-order-only blocks a returning buyer', async () => {
    const { svc } = setup(coupon({ firstOrderOnly: true }), 0, 2);
    await expect(apply(svc)).rejects.toThrow('first order');
  });

  it('a future coupon is rejected', async () => {
    const { svc } = setup(coupon({ startsAt: new Date(Date.now() + 86_400_000) }));
    await expect(apply(svc)).rejects.toThrow('not active yet');
  });

  it('a legacy coupon (no new fields) behaves as before: whole store, no order lookups', async () => {
    const { svc, checkout } = setup(coupon());
    await apply(svc);
    expect(checkout.items[0].totalPrice).toBe(900);
    expect(checkout.items[1].totalPrice).toBe(1800);
    expect((svc as any).databaseService.repositories.orderModel.countDocuments).not.toHaveBeenCalled();
  });

  it('personal / platform-funded coupons ignore the new seller rules', async () => {
    const { svc } = setup(coupon({ ownerUserId: 'u1', platformFunded: false, startsAt: new Date(Date.now() + 86_400_000), perCustomerLimit: 1 }), 5);
    await expect(apply(svc)).resolves.toMatchObject({ success: true });
  });
});

describe('coupon-rules.util', () => {
  it('badge only for public, active, started, unexpired coupons', () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    expect(isBadgeLive({ visibility: 'public', isActive: true })).toBe(true);
    expect(isBadgeLive({ visibility: 'private', isActive: true })).toBe(false);
    expect(isBadgeLive({ isActive: true })).toBe(false); // legacy doc = private
    expect(isBadgeLive({ visibility: 'public', isActive: true, startsAt: future })).toBe(false);
    expect(isBadgeLive({ visibility: 'public', isActive: true, expiresAt: past })).toBe(false);
    expect(isBadgeLive({ visibility: 'public', isActive: false })).toBe(false);
  });
  it('validation rules', () => {
    expect(hasStarted({})).toBe(true);
    expect(couponValueError('percentage', 91)).toBeTruthy();
    expect(couponValueError('percentage', 90)).toBeNull();
    expect(couponValueError('fixed', 0)).toBeTruthy();
    const a = new Date('2026-12-01'), b = new Date('2026-11-01');
    expect(couponDateError(a, b)).toBeTruthy();
    expect(couponDateError(b, a)).toBeNull();
  });
});
