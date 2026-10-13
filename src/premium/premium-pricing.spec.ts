/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from '../checkout/checkout.service';
import { PaymentService } from '../payment/payment.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PremiumEntitlementsService } from './premium-entitlements.service';
import { NON_PREMIUM, termsFromSettings } from './premium.util';
import { feeItemsFor } from '../finance/finance.service';

const chain = (v: any) => {
  const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) };
  return c;
};
const MEMBER = { isPremium: true, childrenLimit: 15, earlyAccessHours: 2, prioritySupport: true };

interface Seed { storeId: string; productId: string; price?: number; compareAt?: number | null; qty?: number; productPct?: number }

/** One USD store world; the store gives premium members 20% unless `storePremium` says otherwise. */
function world(seeds: Seed[], opts: { ent?: any; storePremium?: any; autoDiscount?: boolean; subscriberPct?: number; omitPremiumService?: boolean; platformOn?: boolean; campaignPct?: number; campaignSponsor?: 'seller' | 'platform' } = {}) {
  const userId = 'u1';
  const stores = new Map<string, any>();
  const carts: any[] = [];
  const products = new Map<string, any>();
  const variants = new Map<string, any>();
  for (const s of seeds) {
    if (!stores.has(s.storeId)) {
      stores.set(s.storeId, {
        _id: s.storeId, status: 'active', codEnabled: true, name: `Store ${s.storeId}`, slug: s.storeId, isDelete: false,
        premiumDiscount: opts.storePremium === undefined ? { enabled: true, percent: 20 } : opts.storePremium,
      });
    }
    products.set(s.productId, { _id: s.productId, storeId: s.storeId, sellerId: `seller-${s.storeId}`, name: s.productId, type: 'digital', status: 'active', isDelete: false, images: [], premiumDiscountPercent: s.productPct ?? null });
    variants.set(`v-${s.productId}`, { _id: `v-${s.productId}`, productId: s.productId, status: 'active', isDelete: false, price: s.price ?? 100, compareAtPrice: s.compareAt ?? null, currency: 'USD', unlimitedStock: true, stock: 0, options: [] });
    let cart = carts.find((c) => c.storeId === s.storeId);
    if (!cart) carts.push((cart = { userId, storeId: s.storeId, status: 'active', isDelete: false, items: [] }));
    cart.items.push({ productId: s.productId, productVariantId: `v-${s.productId}`, name: s.productId, quantity: s.qty ?? 1, price: s.price ?? 100 });
  }
  const created: any[] = [];
  const repos: any = {
    cartModel: {
      find: jest.fn((f: any) => chain(carts.filter((c) => c.userId === f.userId && c.status === f.status && !c.isDelete && c.items.length > 0))),
      findOne: jest.fn(async (f: any) => carts.find((c) => c.userId === f.userId && c.storeId === f.storeId && c.status === f.status) ?? null),
    },
    productModel: {
      findOne: jest.fn(async (f: any) => products.get(f._id) ?? null),
      find: jest.fn((f: any) => (f?._id?.$in ? chain(f._id.$in.map((id: string) => products.get(id)).filter(Boolean)) : chain([]))),
      aggregate: jest.fn().mockResolvedValue([]),
    },
    productVariantModel: {
      findOne: jest.fn(async (f: any) => variants.get(f._id) ?? null),
      find: jest.fn((f: any) => chain((f?._id?.$in ?? []).map((id: string) => variants.get(id)).filter(Boolean))),
    },
    storeModel: {
      findOne: jest.fn((f: any) => chain(stores.get(f._id) ?? null)),
      find: jest.fn((f: any) => chain([...stores.values()].filter((s) => f._id.$in.includes(s._id)))),
    },
    sellerModel: { find: jest.fn(() => chain([])) },
    shippingZoneModel: { exists: jest.fn().mockResolvedValue(null) },
    subscriptionPlanModel: { findOne: jest.fn(() => chain(null)) },
    addressModel: { findOne: jest.fn(() => chain(null)) },
    userModel: { findById: jest.fn(() => chain({ currencyPreference: 'USD' })) },
    checkoutModel: { create: jest.fn(async (doc: any) => { const d = { _id: `co${created.length + 1}`, ...doc }; created.push(d); return d; }) },
  };
  const fx = new ExchangeRateService({} as any, {} as any, {} as any);
  jest.spyOn(fx, 'buildSnapshots').mockImplementation(async (cs: string[]) => [...new Set(cs)].map((currency) => ({ currency, ratePerUSD: 1, effectiveFrom: new Date(), source: 'admin', exchangeRateId: null })) as any);
  const campaignsMock = jest.fn().mockResolvedValue(opts.campaignPct
    ? new Map([...stores.keys()].map((id) => [id, [{ campaignId: 'c1', name: 'Flash', discountType: 'percentage', discountValue: opts.campaignPct, currency: null, endDate: new Date(Date.now() + 1e7), sponsorType: opts.campaignSponsor ?? 'platform' }]]))
    : new Map());
  const subscriberPct = opts.subscriberPct;
  const benefits = {
    getActiveBenefits: jest.fn().mockResolvedValue(null),
    getActiveBenefitsBatch: jest.fn().mockResolvedValue(subscriberPct ? new Map([...stores.keys()].map((id) => [id, { benefits: [{}], planName: 'Gold' }])) : new Map()),
    resolveProductDiscount: jest.fn((_b: any, _p: any, price: number) => subscriberPct ? { subscriberPrice: Math.round(price * (1 - subscriberPct / 100) * 100) / 100, savingsUSD: Math.round(price * subscriberPct) / 100, discountPercent: subscriberPct, minOrderValueUSD: null } : null),
  };
  const discounts = {
    getActiveDiscountsForStores: jest.fn().mockResolvedValue(opts.autoDiscount ? new Map([...stores.keys()].map((id) => [id, [{ _id: 'd1', target: 'store', discountType: 'percentage', discountValue: 10, minOrderAmount: null }]])) : new Map()),
  };
  const getEntitlements = jest.fn().mockResolvedValue(opts.ent ?? NON_PREMIUM);
  // platform offer is OFF unless a test turns it on, so the plain seller-percent cases stay easy to read (default admin setting is ON 5%).
  const getTerms = jest.fn().mockResolvedValue(termsFromSettings({ platformDiscount: { enabled: !!opts.platformOn, percent: 5 } }));
  const svc = new CheckoutService(
    { repositories: repos } as any, benefits as any,
    { getActiveCampaignsForStores: campaignsMock } as any,
    { isManualPaymentEnabled: jest.fn().mockResolvedValue(false), isManualTransferAvailable: jest.fn().mockResolvedValue(false) } as any,
    fx, {} as any, discounts as any,
    opts.omitPremiumService ? undefined : ({ getEntitlements, getTerms } as unknown as PremiumEntitlementsService),
  );
  return { svc, repos, created, userId, campaignsMock, getEntitlements, stores };
}
const create = (w: ReturnType<typeof world>) => w.svc.createCheckout(w.userId, { currencyPreference: 'USD' });

describe('Premium member price in createCheckout (owner rules R1-R4)', () => {
  it('seller 20% only (platform offer off): pays list x 0.8; discount recorded on the line and checkout', async () => {
    const w = world([{ storeId: 'A', productId: 'pa', price: 100, qty: 2 }], { ent: MEMBER });
    const { data } = await create(w);
    const i = data.checkout.items[0];
    expect(i.price).toBe(80);
    expect(i.totalPrice).toBe(160);
    expect(i).toMatchObject({ premiumDiscountUSD: 40, premiumPlatformDiscountUSD: 0, premiumDiscountPercent: 20, premiumSellerPercent: 20, premiumPlatformPercent: 0, originalPrice: 100, premiumFeePercent: 5 });
    expect(data.checkout.subtotal).toBe(160);
    expect(data.checkout.isPremiumBuyer).toBe(true);
    expect(data.checkout.premiumDiscountTotalUSD).toBe(40);
    expect(data.checkout.premiumPlatformDiscountTotalUSD).toBe(0);
    expect(data.summary.premiumDiscountUSD).toBe(40);
  });

  it('seller 15% + platform 5% on a product with a normal 10% sale (price 90, compare-at 100): premium pays 80; normal buyer pays 90', async () => {
    const seeds = [{ storeId: 'A', productId: 'pa', price: 90, compareAt: 100, qty: 2, productPct: 15 }];
    const member = (await create(world(seeds, { ent: MEMBER, platformOn: true }))).data;
    const i = member.checkout.items[0];
    expect(i).toMatchObject({ price: 80, totalPrice: 160, originalPrice: 100, premiumDiscountUSD: 30, premiumPlatformDiscountUSD: 10, premiumDiscountPercent: 20, premiumSellerPercent: 15, premiumPlatformPercent: 5 });
    expect(member.checkout.premiumPlatformDiscountTotalUSD).toBe(10);
    expect(member.summary.premiumPlatformDiscountUSD).toBe(10);
    const off = (await create(world(seeds, { ent: MEMBER, platformOn: false }))).data.checkout.items[0];
    expect(off).toMatchObject({ price: 85, totalPrice: 170, premiumPlatformDiscountUSD: 0, premiumDiscountPercent: 15 });
    const normal = (await create(world(seeds, { ent: NON_PREMIUM }))).data.checkout.items[0];
    expect(normal.price).toBe(90); // a normal buyer gets exactly the seller's normal sale
    expect(normal.premiumDiscountPercent ?? 0).toBe(0);
  });

  it('safety net: when premium would not beat the normal sale price the member pays the normal price (never more than a normal buyer)', async () => {
    const w = world([{ storeId: 'A', productId: 'pa', price: 90, compareAt: 100, productPct: 5 }], { ent: MEMBER });
    const i = (await create(w)).data.checkout.items[0];
    expect(i.totalPrice).toBe(90);
    expect(i.premiumDiscountPercent ?? 0).toBe(0);
    expect(i.premiumFeePercent ?? null).toBeNull();
  });

  it('a NON-member pays exactly the same as without the premium module (identical items, no premium fields)', async () => {
    const withSvc = world([{ storeId: 'A', productId: 'pa', price: 100, compareAt: 120, qty: 2 }], { ent: NON_PREMIUM, autoDiscount: true, subscriberPct: 10 });
    const without = world([{ storeId: 'A', productId: 'pa', price: 100, compareAt: 120, qty: 2 }], { omitPremiumService: true, autoDiscount: true, subscriberPct: 10 });
    const a = (await create(withSvc)).data;
    const b = (await create(without)).data;
    const strip = (it: any) => ({ price: it.price, totalPrice: it.totalPrice, originalPrice: it.originalPrice, premium: it.premiumDiscountUSD, auto: it.autoDiscountUSD, sub: it.subscriberDiscountUSD, platform: it.premiumPlatformDiscountUSD, fee: it.premiumFeePercent });
    expect(strip(a.checkout.items[0])).toEqual(strip(b.checkout.items[0]));
    expect(a.checkout.subtotal).toBe(b.checkout.subtotal);
    expect(a.checkout.isPremiumBuyer).toBe(false);
    expect(a.summary.premiumDiscountUSD).toBeUndefined();
    expect(a.checkout.items[0].premiumFeePercent ?? null).toBeNull();
  });

  it('a store that has not enabled it gives nothing; a product override applies on its own', async () => {
    const off = world([{ storeId: 'A', productId: 'pa' }], { ent: MEMBER, storePremium: { enabled: false, percent: 20 }, platformOn: true });
    expect((await create(off)).data.checkout.subtotal).toBe(100); // no seller premium = no platform offer either
    const override = world([{ storeId: 'A', productId: 'pa', productPct: 50 }, { storeId: 'A', productId: 'pb' }], { ent: MEMBER });
    const items = (await create(override)).data.checkout.items;
    expect(items.find((i: any) => i.productId === 'pa').totalPrice).toBe(50); // product 50% beats store 20%
    expect(items.find((i: any) => i.productId === 'pb').totalPrice).toBe(80);
  });

  it('R1: the seller\'s automatic discount is NOT applied on top for a member (non-member still gets it)', async () => {
    const w = world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: MEMBER, autoDiscount: true });
    const i = (await create(w)).data.checkout.items[0];
    expect(i.autoDiscountUSD ?? 0).toBe(0);
    expect(i.totalPrice).toBe(80); // premium price only
    const normal = (await create(world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: NON_PREMIUM, autoDiscount: true }))).data.checkout.items[0];
    expect(normal.totalPrice).toBe(90);
  });

  it('R1: a store-subscriber price is replaced by a better premium price; a better subscriber price stays (never charged more)', async () => {
    const worse = world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: MEMBER, subscriberPct: 5 });
    const a = (await create(worse)).data;
    expect(a.checkout.items[0].totalPrice).toBe(80);
    expect(a.checkout.items[0].subscriberDiscountUSD).toBe(0);
    expect(a.summary.subscriberSavingsUSD).toBe(0); // the replaced subscriber saving is not double counted
    const better = world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: MEMBER, subscriberPct: 30 });
    const b = (await create(better)).data;
    expect(b.checkout.items[0].totalPrice).toBe(70);
    expect(b.checkout.items[0].premiumDiscountUSD ?? 0).toBe(0);
  });

  it('the premium fee % is frozen on the line from the admin setting at checkout time', async () => {
    const w = world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: MEMBER });
    expect((await create(w)).data.checkout.items[0].premiumFeePercent).toBe(5);
  });
  it('campaign BETTER than premium: the member line reverts to the normal pipeline (same as a normal buyer, no premium fields, no premium fee)', async () => {
    const seeds = [{ storeId: 'A', productId: 'pa', price: 100 }];
    const member = (await create(world(seeds, { ent: MEMBER, campaignPct: 30 }))).data; // premium 20% -> 80, campaign 30% -> 70
    const normal = (await create(world(seeds, { ent: NON_PREMIUM, campaignPct: 30 }))).data;
    const m = member.checkout.items[0];
    expect(m.totalPrice).toBe(70);
    expect(m).toMatchObject({ campaignDiscountUSD: 30, campaignSponsorType: 'platform' });
    expect(m.premiumDiscountPercent ?? 0).toBe(0);
    expect(m.premiumDiscountUSD ?? 0).toBe(0);
    expect(m.premiumPlatformDiscountUSD ?? 0).toBe(0);
    expect(m.premiumFeePercent ?? null).toBeNull();
    expect(member.checkout.premiumDiscountTotalUSD).toBe(0);
    expect(member.checkout.premiumPlatformDiscountTotalUSD).toBe(0);
    expect(member.summary.campaignDiscountUSD).toBe(normal.summary.campaignDiscountUSD);
    expect(member.checkout.subtotal).toBe(normal.checkout.subtotal);
    expect(member.appliedCampaigns[0].discountUSD).toBe(30);
  });
  it('campaign equal to premium: ties go to the normal pipeline', async () => {
    const m = (await create(world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: MEMBER, campaignPct: 20 }))).data.checkout.items[0];
    expect(m.totalPrice).toBe(80);
    expect(m.campaignDiscountUSD).toBe(20);
    expect(m.premiumFeePercent ?? null).toBeNull();
  });
  it('premium BETTER than campaign: premium applies, the campaign discount is removed from the line and the totals', async () => {
    const { data } = await create(world([{ storeId: 'A', productId: 'pa', price: 100 }], { ent: MEMBER, campaignPct: 10, platformOn: true })); // normal 90, premium 75
    const i = data.checkout.items[0];
    expect(i).toMatchObject({ totalPrice: 75, premiumDiscountPercent: 25, premiumFeePercent: 5, premiumPlatformDiscountUSD: 5 });
    expect(i.campaignDiscountUSD ?? 0).toBe(0);
    expect(i.campaignSponsorType ?? null).toBeNull();
    expect(data.summary.campaignDiscountUSD).toBe(0);
    expect(data.appliedCampaigns[0].discountUSD).toBe(0);
    expect(data.checkout.campaignDiscountTotalUSD).toBe(0);
  });
  it('mixed cart: each line takes its better price (one reverts to the campaign, one keeps premium)', async () => {
    const seeds = [{ storeId: 'A', productId: 'pa', price: 100 }, { storeId: 'A', productId: 'pb', price: 100, productPct: 50 }];
    const items = (await create(world(seeds, { ent: MEMBER, campaignPct: 30 }))).data.checkout.items;
    expect(items.find((i: any) => i.productId === 'pa').totalPrice).toBe(70); // campaign beats premium 20%
    expect(items.find((i: any) => i.productId === 'pb').totalPrice).toBe(50); // premium 50% beats campaign
    expect(items.find((i: any) => i.productId === 'pb').campaignDiscountUSD ?? 0).toBe(0);
  });
  it('campaign early access: only a member asks for campaigns up to earlyAccessHours ahead (re-validated server-side)', async () => {
    const m = world([{ storeId: 'A', productId: 'pa' }], { ent: MEMBER });
    await create(m);
    expect(m.campaignsMock).toHaveBeenCalledWith(['A'], { earlyAccessHours: 2 });
    const n = world([{ storeId: 'A', productId: 'pa' }]);
    await create(n);
    expect(n.campaignsMock).toHaveBeenCalledWith(['A'], {});
  });
});

// ── platform-funded coupon: who pays ────────────────────────────────────────────────────────────────────────────
const coupon = (over: any) => ({ code: 'PRMTEST', isActive: true, isDelete: false, scope: 'platform', storeId: null, discountType: 'percentage', discountValue: 10, currency: null, usageCount: 0, usageLimit: 1, expiresAt: null, minOrderAmount: null, ownerUserId: null, platformFunded: false, ...over });

function couponCtx(c: any, ent: any = MEMBER) {
  const checkout: any = {
    _id: 'chk1', userId: 'u1', status: 'pending', currency: 'USD', fxSnapshots: [{ currency: 'USD', ratePerUSD: 1 }], expiredAt: null, shippingFee: 0,
    items: [{ storeId: 'A', productId: 'pa', variantId: 'v1', sellerId: 's', type: 'digital', name: 'x', quantity: 1, price: 100, totalPrice: 100, currency: 'USD', couponDiscountUSD: 0, giftCardDiscountUSD: 0, campaignDiscountUSD: 0, options: [] }],
  };
  const update = jest.fn().mockResolvedValue({});
  const repos: any = { checkoutModel: { findOne: jest.fn().mockResolvedValue(checkout), findByIdAndUpdate: update }, couponModel: { findOne: jest.fn().mockResolvedValue(c) }, rewardVoucherModel: { findOne: jest.fn().mockResolvedValue(null) } };
  const svc = new CheckoutService({ repositories: repos } as any, {} as any, {} as any, {} as any, new ExchangeRateService({} as any, {} as any, {} as any), {} as any, {} as any, { getEntitlements: jest.fn().mockResolvedValue(ent) } as any);
  return { svc, checkout };
}

describe('personal platform-funded coupon (Premium monthly coupon)', () => {
  it('applies for its owner and tags the lines platform-funded', async () => {
    const { svc, checkout } = couponCtx(coupon({ ownerUserId: 'u1', platformFunded: true }));
    await svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'prmtest' });
    expect(checkout.items[0].couponDiscountUSD).toBe(10);
    expect(checkout.items[0].couponSponsorType).toBe('platform');
    expect(checkout.items[0].totalPrice).toBe(90);
  });
  it('a different buyer cannot use it; an owner who is no longer a member cannot either', async () => {
    const other = couponCtx(coupon({ ownerUserId: 'someone', platformFunded: true }));
    await expect(other.svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'prmtest' })).rejects.toBeInstanceOf(BadRequestException);
    const lapsed = couponCtx(coupon({ ownerUserId: 'u1', platformFunded: true }), NON_PREMIUM);
    await expect(lapsed.svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'prmtest' })).rejects.toThrow(/Premium members/);
  });
  it('an ordinary platform coupon is NOT tagged (unchanged: the seller still bears it)', async () => {
    const { svc, checkout } = couponCtx(coupon({}));
    await svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'prmtest' });
    expect(checkout.items[0].couponDiscountUSD).toBe(10);
    expect(checkout.items[0].couponSponsorType ?? null).toBeNull();
  });
  it('removing/replacing the coupon clears the platform-funded tag', async () => {
    const { svc, checkout } = couponCtx(coupon({ ownerUserId: 'u1', platformFunded: true }));
    await svc.applyCoupon('u1', { checkoutId: 'chk1', code: 'prmtest' });
    await svc.removeCoupon('u1', { checkoutId: 'chk1' });
    expect(checkout.items[0].couponSponsorType).toBeNull();
    expect(checkout.items[0].totalPrice).toBe(100);
  });
});

// ── seller credit math through createOrder ───────────────────────────────────────────────────────────────────────
function placeOrder(items: any[]) {
  const checkout: any = { _id: 'chk1', userId: 'u1', currency: 'USD', fxSnapshots: [{ currency: 'USD', ratePerUSD: 1 }], addressId: null, items, subtotal: 0, shippingFee: 0, totalAmount: 0, shippingByStore: [], attributionSource: 'other', isPremiumBuyer: true };
  const created: any[] = [];
  const orderModel: any = { find: jest.fn(async () => created.slice()), create: jest.fn(async (doc: any) => { const o = { _id: `o${created.length + 1}`, ...doc }; created.push(o); return o; }) };
  const repos: any = {
    productVariantModel: { findOne: jest.fn(), find: jest.fn(() => chain([])), updateOne: jest.fn() },
    productModel: { findByIdAndUpdate: jest.fn().mockResolvedValue({}), bulkWrite: jest.fn().mockResolvedValue({}) },
    storeModel: { find: jest.fn(() => chain([{ _id: 'A', baseCurrency: 'USD', fulfillmentMode: 'seller' }])) },
    couponModel: { updateOne: jest.fn() }, rewardVoucherModel: { updateOne: jest.fn() },
  };
  const svc: any = Object.create(PaymentService.prototype);
  Object.assign(svc, {
    databaseService: { repositories: repos },
    exchangeRateService: new ExchangeRateService({} as any, {} as any, {} as any),
    notificationsService: { notify: jest.fn().mockResolvedValue(undefined) },
    promotionsService: { recordConversions: jest.fn().mockResolvedValue(undefined) },
    giftCardsService: { redeemAtOrderPlacement: jest.fn() }, activityLogService: { log: jest.fn() },
  });
  return svc.createOrder('u1', checkout, orderModel, { findOne: jest.fn() }, { paymentType: 'stripe', isPaid: true }, { paymentType: 'stripe', isPaid: true });
}
const orderLine = (over: any) => ({ productId: 'p1', variantId: 'v1', sellerId: 's', storeId: 'A', type: 'digital', name: 'x', quantity: 1, price: 100, totalPrice: 100, currency: 'USD', options: [], ...over });
const payoutBasis = (so: any) => (so.settlementAmount != null ? so.settlementAmount : so.subtotal + (so.platformSponsoredDiscountUSD ?? 0));

describe('seller credit math with Premium', () => {
  it('platform-funded coupon: the seller is credited the FULL pre-coupon price (platform covers the discount), like a platform-sponsored campaign', async () => {
    const [order] = await placeOrder([orderLine({ price: 90, totalPrice: 90, couponDiscountUSD: 10, couponSponsorType: 'platform' })]);
    const so = order.sellerOrders[0];
    expect(so.subtotal).toBe(90); // what the buyer paid
    expect(so.platformSponsoredDiscountUSD).toBe(10);
    expect(payoutBasis(so)).toBe(100); // seller credit unchanged = full price
    expect(order.platformSponsoredDiscountTotal).toBe(10);
    expect(order.isPremiumOrder).toBe(true);
  });
  it('an ordinary platform coupon still comes out of the seller (behaviour unchanged)', async () => {
    const [order] = await placeOrder([orderLine({ price: 90, totalPrice: 90, couponDiscountUSD: 10 })]);
    const so = order.sellerOrders[0];
    expect(so.platformSponsoredDiscountUSD).toBe(0);
    expect(payoutBasis(so)).toBe(90);
  });
  it('seller-funded premium price: credited after the discount exactly like other seller discounts, and recorded for reporting', async () => {
    const [order] = await placeOrder([orderLine({ price: 80, totalPrice: 80, originalPrice: 100, premiumDiscountUSD: 20, premiumDiscountPercent: 20 })]);
    const so = order.sellerOrders[0];
    expect(payoutBasis(so)).toBe(80);
    expect(so.platformSponsoredDiscountUSD).toBe(0);
    expect(so.items[0]).toMatchObject({ premiumDiscountUSD: 20, premiumDiscountPercent: 20 });
    expect(order.premiumDiscountTotal).toBe(20);
  });
  it('premium price + platform-funded coupon together: seller gets the member price, never less', async () => {
    const [order] = await placeOrder([orderLine({ price: 72, totalPrice: 72, originalPrice: 100, premiumDiscountUSD: 20, premiumDiscountPercent: 20, couponDiscountUSD: 8, couponSponsorType: 'platform' })]);
    const so = order.sellerOrders[0];
    expect(so.subtotal).toBe(72);
    expect(payoutBasis(so)).toBe(80); // member price (100 - 20 own discount); the 8 coupon is the platform's
  });
  it('platform-funded premium offer: buyer pays 80, the seller is credited S=85 (platform covers 5), breakdown stored for reporting', async () => {
    const [order] = await placeOrder([orderLine({ price: 80, totalPrice: 80, originalPrice: 100, premiumDiscountUSD: 15, premiumPlatformDiscountUSD: 5, premiumDiscountPercent: 20, premiumSellerPercent: 15, premiumPlatformPercent: 5, premiumFeePercent: 5 })]);
    const so = order.sellerOrders[0];
    expect(so.subtotal).toBe(80);
    expect(so.platformSponsoredDiscountUSD).toBe(5);
    expect(payoutBasis(so)).toBe(85);
    expect(so.items[0]).toMatchObject({ premiumDiscountUSD: 15, premiumPlatformDiscountUSD: 5, premiumSellerPercent: 15, premiumPlatformPercent: 5, premiumFeePercent: 5 });
    expect(order.platformSponsoredDiscountTotal).toBe(5);
    expect(order.premiumDiscountTotal).toBe(15);
    expect(order.premiumPlatformDiscountTotal).toBe(5);
  });
  it('platform premium offer + platform-funded PRM coupon together: the seller still gets S, never pays for either', async () => {
    const [order] = await placeOrder([orderLine({ price: 80, totalPrice: 72, originalPrice: 100, premiumDiscountUSD: 15, premiumPlatformDiscountUSD: 5, premiumDiscountPercent: 20, premiumFeePercent: 5, couponDiscountUSD: 8, couponSponsorType: 'platform' })]);
    const so = order.sellerOrders[0];
    expect(so.subtotal).toBe(72);
    expect(so.platformSponsoredDiscountUSD).toBe(13);
    expect(payoutBasis(so)).toBe(85);
    expect(order.platformSponsoredDiscountTotal).toBe(13);
  });
  it('a normal order has no premium fields set (fee % null, platform part 0)', async () => {
    const [order] = await placeOrder([orderLine({ price: 90, totalPrice: 90 })]);
    expect(order.sellerOrders[0].items[0]).toMatchObject({ premiumPlatformDiscountUSD: 0, premiumFeePercent: null });
    expect(order.premiumPlatformDiscountTotal).toBe(0);
  });  it('seller credit when the campaign beat premium (line reverted): platform-sponsored campaign restores the full price, normal fee path (no premium fee)', async () => {
    const [order] = await placeOrder([orderLine({ price: 70, totalPrice: 70, originalPrice: 100, campaignId: 'c1', campaignDiscountUSD: 30, campaignSponsorType: 'platform', premiumFeePercent: null })]);
    const so = order.sellerOrders[0];
    expect(payoutBasis(so)).toBe(100);
    expect(so.platformSponsoredDiscountUSD).toBe(30);
    expect(so.items[0]).toMatchObject({ premiumPlatformDiscountUSD: 0, premiumFeePercent: null, premiumDiscountPercent: 0 });
    expect(order.premiumPlatformDiscountTotal).toBe(0);
    expect(order.premiumDiscountTotal).toBe(0);
    expect(feeItemsFor(so)).toEqual([{ type: 'digital', totalPrice: 70, quantity: 1 }]); // normal per-type fee, no premium override
  });
  it('seller credit when premium beat the campaign: S = seller-side price, premium fee % carried to the fee items', async () => {
    const [order] = await placeOrder([orderLine({ price: 75, totalPrice: 75, originalPrice: 100, premiumDiscountUSD: 20, premiumPlatformDiscountUSD: 5, premiumDiscountPercent: 25, premiumFeePercent: 5 })]);
    const so = order.sellerOrders[0];
    expect(payoutBasis(so)).toBe(80);
    expect(so.platformSponsoredDiscountUSD).toBe(5);
    expect(feeItemsFor(so)).toEqual([{ type: 'digital', totalPrice: 80, quantity: 1, feePercent: 5 }]);
  });});
