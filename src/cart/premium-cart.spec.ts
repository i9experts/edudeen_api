/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { CartService } from './cart.service';
import { termsFromSettings } from '../premium/premium.util';

const STORE = '64f0c0ffee0c0ffee0c0ff0a';
const P1 = '64f0c0ffee0c0ffee0c0fa01';
const V1 = '64f0c0ffee0c0ffee0c0fa02';

const chain = (v: any) => {
  const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) };
  return c;
};

function cartSvc(opts: { member: boolean; platformOn: boolean; price: number; compareAt?: number | null; productPct?: number | null; storePct?: number; campaignPct?: number; unticked?: boolean; optOut?: boolean }) {
  const cart = { userId: 'u1', storeId: STORE, isDelete: false, items: [{ productId: P1, productVariantId: V1, name: 'Item', quantity: 2, price: opts.price, currency: 'USD', images: [], options: [] }] };
  const repos: any = {
    cartModel: { findOne: jest.fn().mockResolvedValue(cart) },
    productModel: { aggregate: jest.fn().mockResolvedValue([]), find: jest.fn(() => chain([{ _id: P1, images: [], status: 'active', isDelete: false, storeId: STORE, premiumDiscountPercent: opts.productPct ?? null, campaignIds: opts.campaignPct && !opts.unticked ? ['c1'] : [], premiumOptOut: !!opts.optOut }])) },
    sellerModel: { find: jest.fn(() => chain([])) },
    productVariantModel: { find: jest.fn(() => chain([{ _id: V1, price: opts.price, compareAtPrice: opts.compareAt ?? null, currency: 'USD' }])) },
    campaignModel: { find: jest.fn(() => chain(opts.campaignPct ? [{ _id: 'c1', name: 'Flash', endDate: new Date(Date.now() + 1e7), discountType: 'percentage', discountValue: opts.campaignPct, currency: null, sponsorType: 'platform' }] : [])) },
  };
  const premium: any = {
    getEntitlements: jest.fn().mockResolvedValue(opts.member ? { isPremium: true, earlyAccessHours: 0 } : { isPremium: false, earlyAccessHours: 0 }),
    loadStoreSettings: jest.fn().mockResolvedValue(new Map([[STORE, { premiumDiscount: opts.storePct ? { enabled: true, percent: opts.storePct } : null }]])),
    getTerms: jest.fn().mockResolvedValue(termsFromSettings({ platformDiscount: { enabled: opts.platformOn, percent: 5 } })),
  };
  return new CartService({ repositories: repos } as any, undefined as any, premium);
}

describe('cart premium display = checkout price (R2/R6)', () => {
  it('member: LIST x (1 - seller% - platform%) with the original list price; normal sale ignored', async () => {
    const { data } = await cartSvc({ member: true, platformOn: true, price: 90, compareAt: 100, productPct: 15 }).getCart('u1', STORE) as any;
    expect(data.items[0]).toMatchObject({ unitPrice: 90, premiumUnitPrice: 80, premiumItemTotal: 160, listPrice: 100, premiumDiscountPercent: 20, premiumSellerPercent: 15, premiumPlatformPercent: 5, premiumPercent: 20 });
    expect(data.isPremium).toBe(true);
    expect(data.premiumSavings).toBe(20); // (90 - 80) x 2 vs the normal buyer
    expect(data.premiumPlatformFunded).toBe(10); // 5 x 2 paid by Edudeen
  });
  it('platform offer off: seller part only', async () => {
    const { data } = await cartSvc({ member: true, platformOn: false, price: 90, compareAt: 100, productPct: 15 }).getCart('u1', STORE) as any;
    expect(data.items[0]).toMatchObject({ premiumUnitPrice: 85, premiumPlatformPercent: 0, premiumPercent: 15 });
    expect(data.premiumPlatformFunded).toBe(0);
  });
  it('non-member: teaser only (seller + platform combined with breakdown), no premium price; totals unchanged', async () => {
    const { data } = await cartSvc({ member: false, platformOn: true, price: 90, compareAt: 100, productPct: 15 }).getCart('u1', STORE) as any;
    expect(data.items[0]).toMatchObject({ premiumPercent: 20, premiumSellerPercent: 15, premiumPlatformPercent: 5 });
    expect(data.items[0].premiumUnitPrice).toBeUndefined();
    expect(data.totalPrice).toBe(180);
    expect(data.isPremium).toBeUndefined();
  });
  it('safety net: premium not better than the normal price -> no premium price shown', async () => {
    const { data } = await cartSvc({ member: true, platformOn: false, price: 90, compareAt: 100, productPct: 5 }).getCart('u1', STORE) as any;
    expect(data.items[0].premiumUnitPrice).toBeUndefined();
    expect(data.items[0].premiumPercent).toBe(5);
  });
  it('campaign BETTER than premium: no premium price shown, the campaign discount stays (member pays what a normal buyer pays)', async () => {
    const { data } = await cartSvc({ member: true, platformOn: false, price: 100, productPct: 20, campaignPct: 30 }).getCart('u1', STORE) as any;
    expect(data.items[0].premiumUnitPrice).toBeUndefined();
    expect(data.items[0].onCampaign).toBe(true);
    expect(data.campaignDiscount.amount).toBe(60); // 30% of 200
    expect(data.premiumSavings).toBe(0);
  });
  it('premium BETTER than campaign: premium price shown and the campaign no longer discounts that line', async () => {
    const { data } = await cartSvc({ member: true, platformOn: false, price: 100, productPct: 20, campaignPct: 10 }).getCart('u1', STORE) as any;
    expect(data.items[0].premiumUnitPrice).toBe(80);
    expect(data.items[0].onCampaign).toBe(false);
    expect(data.campaignDiscount).toBeNull();
  });});

describe('cart campaign price: LIST-price base + strict per-product opt-in (owner rules R1/R2/R6)', () => {
  it('10% mega sale on price 500 / compare 550 => 495 per unit (not 450), discount 5 each', async () => {
    const { data } = await cartSvc({ member: false, platformOn: false, price: 500, compareAt: 550, campaignPct: 10 }).getCart('u1', STORE) as any;
    expect(data.items[0]).toMatchObject({ onCampaign: true, campaignUnitPrice: 495, campaignItemTotal: 990, listPrice: 550 });
    expect(data.campaignDiscount.amount).toBe(10); // (500 - 495) x 2
    expect(data.totalAfterDiscount).toBe(990);
  });
  it('5% on 500 / 550 => 522.5 is not cheaper than 500: no campaign on the line', async () => {
    const { data } = await cartSvc({ member: false, platformOn: false, price: 500, compareAt: 550, campaignPct: 5 }).getCart('u1', STORE) as any;
    expect(data.items[0].onCampaign).toBe(false);
    expect(data.campaignDiscount).toBeNull();
    expect(data.totalAfterDiscount).toBe(1000);
  });
  it('regression: a product the seller never ticked gets NO campaign price in a participating store', async () => {
    const { data } = await cartSvc({ member: false, platformOn: false, price: 100, campaignPct: 30, unticked: true }).getCart('u1', STORE) as any;
    expect(data.items[0].onCampaign).toBe(false);
    expect(data.campaignDiscount).toBeNull();
  });
  it('premiumOptOut: no premium offer (teaser / price) even with a store-wide default', async () => {
    const { data } = await cartSvc({ member: true, platformOn: false, price: 100, storePct: 20, optOut: true }).getCart('u1', STORE) as any;
    expect(data.items[0].premiumPercent).toBeUndefined();
    expect(data.items[0].premiumUnitPrice).toBeUndefined();
  });
});