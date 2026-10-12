/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const SNAP = [
  { currency: 'PKR', ratePerUSD: 280 },
  { currency: 'USD', ratePerUSD: 1 },
];
const line = (
  storeId: string,
  productId: string,
  totalPrice: number,
  currency: string,
) => ({
  storeId,
  productId,
  variantId: `v-${productId}`,
  type: 'digital',
  quantity: 1,
  price: totalPrice,
  totalPrice,
  currency,
  couponDiscountUSD: 0,
  giftCardDiscountUSD: 0,
  campaignDiscountUSD: 0,
});

/** Checkout across A (PKR 1000), B (PKR 3000), C (USD 10 = PKR 2800); subtotal PKR 6800, shipping PKR 300. */
function setup(opts: { coupon?: any; giftCards?: Record<string, any> } = {}) {
  const checkout: any = {
    _id: 'chk1',
    userId: 'u1',
    status: 'pending',
    currency: 'PKR',
    fxSnapshots: SNAP,
    expiredAt: null,
    shippingFee: 300,
    items: [
      line('A', 'pa', 1000, 'PKR'),
      line('B', 'pb', 3000, 'PKR'),
      line('C', 'pc', 10, 'USD'),
    ],
  };
  const update = jest.fn().mockResolvedValue({});
  const repos: any = {
    checkoutModel: {
      findOne: jest.fn().mockResolvedValue(checkout),
      findByIdAndUpdate: update,
    },
    couponModel: { findOne: jest.fn().mockResolvedValue(opts.coupon ?? null) },
    rewardVoucherModel: { findOne: jest.fn().mockResolvedValue(null) },
  };
  const giftCards: any = {
    findRedeemable: jest.fn(
      async (storeId: string) => opts.giftCards?.[storeId] ?? null,
    ),
  };
  const svc = new CheckoutService(
    { repositories: repos } as any,
    {} as any,
    {} as any,
    {} as any,
    new ExchangeRateService({} as any, {} as any, {} as any),
    giftCards,
    {} as any,
  );
  const saved = () => update.mock.calls[update.mock.calls.length - 1][1];
  const discountOf = (storeId: string) =>
    checkout.items
      .filter((i: any) => i.storeId === storeId)
      .reduce((s: number, i: any) => s + (i.couponDiscountUSD || 0), 0);
  return { svc, checkout, saved, discountOf };
}
const coupon = (over: any) => ({
  code: 'SAVE',
  isActive: true,
  isDelete: false,
  scope: 'seller',
  storeId: 'A',
  discountType: 'percentage',
  discountValue: 10,
  currency: 'PKR',
  usageCount: 0,
  usageLimit: null,
  expiresAt: null,
  minOrderAmount: null,
  ...over,
});

describe('multi-store coupons', () => {
  it("a STORE coupon discounts only its own store's items", async () => {
    const { svc, checkout, saved } = setup({
      coupon: coupon({ storeId: 'B', discountValue: 10 }),
    });
    await svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' });
    expect(checkout.items.find((i: any) => i.storeId === 'B').totalPrice).toBe(
      2700,
    ); // 3000 - 10%
    expect(checkout.items.find((i: any) => i.storeId === 'A').totalPrice).toBe(
      1000,
    ); // untouched
    expect(checkout.items.find((i: any) => i.storeId === 'C').totalPrice).toBe(
      10,
    ); // untouched
    expect(saved()).toMatchObject({
      couponStoreId: 'B',
      couponDiscountTotalUSD: 300,
      subtotal: 6500,
      totalAmount: 6800,
    });
  });

  it('a PLATFORM coupon spans all items of all stores and currencies', async () => {
    const { svc, checkout, saved } = setup({
      coupon: coupon({
        scope: 'platform',
        storeId: null,
        discountValue: 10,
        currency: 'USD',
      }),
    });
    await svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' });
    for (const i of checkout.items)
      expect(i.couponDiscountUSD).toBeGreaterThan(0);
    // 10% of the PKR 6800 basket, whatever the per-line currency
    expect(saved().couponDiscountTotalUSD).toBe(680);
    expect(saved().subtotal).toBeCloseTo(6120, 0);
    expect(saved().couponStoreId).toBeNull();
  });

  it('the total can never go below the shipping: an oversized fixed coupon zeroes the items, not below', async () => {
    const { svc, checkout, saved } = setup({
      coupon: coupon({
        scope: 'platform',
        storeId: null,
        discountType: 'fixed',
        discountValue: 1_000_000,
        currency: 'PKR',
      }),
    });
    await svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' });
    for (const i of checkout.items)
      expect(i.totalPrice).toBeGreaterThanOrEqual(0);
    expect(saved().subtotal).toBeGreaterThanOrEqual(0);
    expect(saved().subtotal).toBeLessThan(1);
    expect(saved().totalAmount).toBeCloseTo(300, 0); // only shipping left
  });

  it('a coupon of a store that is NOT in the checkout is not found', async () => {
    const { svc } = setup({ coupon: null });
    await expect(
      svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a coupon that has reached its usage limit is refused', async () => {
    const { svc } = setup({ coupon: coupon({ usageLimit: 5, usageCount: 5 }) });
    await expect(
      svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' }),
    ).rejects.toThrow(/usage limit/);
  });

  it('re-applying never compounds: switching coupons recomputes from the undiscounted prices', async () => {
    const ctx = setup({ coupon: coupon({ storeId: 'B', discountValue: 10 }) });
    await ctx.svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' });
    await ctx.svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'save' });
    expect(
      ctx.checkout.items.find((i: any) => i.storeId === 'B').totalPrice,
    ).toBe(2700);
  });
});

describe('multi-store gift cards', () => {
  const card = (storeId: string, balance: number) => ({
    _id: `gc-${storeId}`,
    storeId,
    code: 'GC1',
    balance,
    currency: storeId === 'C' ? 'USD' : 'PKR',
  });

  it("applies only to the items of the card's own store", async () => {
    const { svc, checkout, saved } = setup({
      giftCards: { B: card('B', 500) },
    });
    await svc.applyGiftCard('u1', { checkoutId: 'chk1', code: 'gc1' });
    const total = (s: string) =>
      checkout.items
        .filter((i: any) => i.storeId === s)
        .reduce((x: number, i: any) => x + i.totalPrice, 0);
    expect(total('B')).toBe(2500);
    expect(total('A')).toBe(1000);
    expect(total('C')).toBe(10);
    expect(saved()).toMatchObject({
      giftCardStoreId: 'B',
      giftCardDiscountTotalUSD: 500,
    });
  });

  it("a card bigger than its store's items covers only those items — never the other stores', never below zero", async () => {
    const { svc, checkout, saved } = setup({
      giftCards: { A: card('A', 99_999) },
    });
    await svc.applyGiftCard('u1', { checkoutId: 'chk1', code: 'gc1' });
    expect(checkout.items.find((i: any) => i.storeId === 'A').totalPrice).toBe(
      0,
    );
    expect(checkout.items.find((i: any) => i.storeId === 'B').totalPrice).toBe(
      3000,
    );
    expect(saved().giftCardDiscountTotalUSD).toBe(1000); // capped at A's subtotal, not the card's balance
    expect(saved().totalAmount).toBeGreaterThanOrEqual(300); // shipping still due
  });

  it('a code that is not a card of any store in the checkout is refused', async () => {
    const { svc } = setup({ giftCards: {} });
    await expect(
      svc.applyGiftCard('u1', { checkoutId: 'chk1', code: 'gc1' }),
    ).rejects.toThrow(/invalid, inactive, or not applicable/);
  });
});
