import { BadRequestException } from '@nestjs/common';
import {
  addPeriod, applyPremiumToLine, cleanPremiumPercent, cleanPremiumSettings, cleanStorePremiumDiscount, listUnitPrice, monthKey, normalSalePercent,
  premiumGapViolation, premiumLinePrice, premiumPercentFor, premiumUnitPrice, termsFromSettings,
} from './premium.util';

const line = (over: any = {}) => ({ price: 100, totalPrice: 200, quantity: 2, originalPrice: null, subscriberDiscountUSD: 0, campaignDiscountUSD: 0, autoDiscountUSD: 0, ...over });

describe('premiumPercentFor', () => {
  const store = { premiumDiscount: { enabled: true, percent: 10 } };
  it('uses the store percent, the product override wins', () => {
    expect(premiumPercentFor({}, store)).toBe(10);
    expect(premiumPercentFor({ premiumDiscountPercent: 25 }, store)).toBe(25);
  });
  it('is 0 when the store has not enabled it and the product has no override', () => {
    expect(premiumPercentFor({}, { premiumDiscount: { enabled: false, percent: 10 } })).toBe(0);
    expect(premiumPercentFor({}, null)).toBe(0);
    expect(premiumPercentFor({}, { premiumDiscount: null })).toBe(0);
  });
  it('ignores out-of-range values', () => {
    expect(premiumPercentFor({ premiumDiscountPercent: 80 }, { premiumDiscount: { enabled: true, percent: 99 } })).toBe(0);
  });
});

describe('validation', () => {
  it('product percent: undefined untouched, null clears, 1-50 accepted, else 400', () => {
    expect(cleanPremiumPercent(undefined)).toBeUndefined();
    expect(cleanPremiumPercent(null)).toBeNull();
    expect(cleanPremiumPercent(20)).toBe(20);
    for (const bad of [0, 51, -3, 'abc', NaN]) expect(() => cleanPremiumPercent(bad)).toThrow(BadRequestException);
  });
  it('store setting: {enabled, percent 1-50}', () => {
    expect(cleanStorePremiumDiscount({ enabled: true, percent: 15 })).toEqual({ enabled: true, percent: 15 });
    expect(cleanStorePremiumDiscount(null)).toBeNull();
    expect(cleanStorePremiumDiscount(undefined)).toBeUndefined();
    expect(() => cleanStorePremiumDiscount({ enabled: true, percent: 60 })).toThrow(BadRequestException);
    expect(() => cleanStorePremiumDiscount('x')).toThrow(BadRequestException);
  });
});

const T5 = termsFromSettings(); // platform 5% on, fee 5%, gap 5
const T0 = termsFromSettings({ platformDiscount: { enabled: false, percent: 5 } });

describe('premiumLinePrice - R2 additive, list-based', () => {
  it('list 100, normal sale 10% (price 90, compare-at 100), seller 15% + platform 5% -> 80; platform off -> 85', () => {
    const on = premiumLinePrice(90, 100, 15, 5);
    expect(on).toMatchObject({ applies: true, listUnit: 100, unit: 80, totalPercent: 20, sellerUnitDiscount: 15, platformUnitDiscount: 5 });
    expect(premiumLinePrice(90, 100, 15, 0)).toMatchObject({ applies: true, unit: 85, sellerUnitDiscount: 15, platformUnitDiscount: 0 });
  });
  it('no compare-at: list = price; additive not compounded (not 100 x .85 x .95)', () => {
    const c = premiumLinePrice(100, null, 15, 5);
    expect(c.unit).toBe(80);
    expect(c.unit).not.toBe(80.75);
  });
  it('compare-at at or below price is not a sale: list = price', () => {
    expect(listUnitPrice(100, 100)).toBe(100);
    expect(listUnitPrice(100, 80)).toBe(100);
    expect(listUnitPrice(90, 100)).toBe(100);
    expect(normalSalePercent(90, 100)).toBeCloseTo(10, 6);
    expect(normalSalePercent(100, null)).toBe(0);
  });
  it('safety net: a member is never charged more than a normal buyer (premium not strictly better -> not applied)', () => {
    expect(premiumLinePrice(90, 100, 5, 5)).toMatchObject({ applies: false, unit: 90 }); // 90 == 90
    expect(premiumLinePrice(90, 100, 5, 0)).toMatchObject({ applies: false, unit: 90 }); // premium 95 > 90
    expect(premiumLinePrice(90, 100, 8, 0).applies).toBe(false); // 92 > 90
  });
  it('no seller premium = no premium price even if the platform offer is on', () => {
    expect(premiumLinePrice(100, null, 0, 5).applies).toBe(false);
  });
  it('rounds to cents and the parts add up: unit + platform part = what the seller is credited', () => {
    const c = premiumLinePrice(9.99, null, 15, 5);
    expect(c.unit).toBe(7.99);
    expect(round(c.unit + c.platformUnitDiscount)).toBe(round(9.99 - c.sellerUnitDiscount));
  });
});
const round = (n: number) => Math.round(n * 100) / 100;

describe('applyPremiumToLine (R1: only the premium price)', () => {
  const variant = { price: 90, compareAtPrice: 100 };
  it('prices a line from the LIST price, tags seller/platform parts and the premium fee', () => {
    const l = line({ price: 90, totalPrice: 180 });
    const r = applyPremiumToLine(l, variant, 15, T5);
    expect(r).toMatchObject({ applied: true, sellerDiscount: 30, platformDiscount: 10 });
    expect(l).toMatchObject({ price: 80, totalPrice: 160, originalPrice: 100, premiumDiscountUSD: 30, premiumPlatformDiscountUSD: 10, premiumDiscountPercent: 20, premiumSellerPercent: 15, premiumPlatformPercent: 5, premiumFeePercent: 5 });
  });
  it('platform offer off: seller part only, platform part 0', () => {
    const l = line({ price: 90, totalPrice: 180 });
    applyPremiumToLine(l, variant, 15, T0);
    expect(l).toMatchObject({ price: 85, totalPrice: 170, premiumDiscountUSD: 30, premiumPlatformDiscountUSD: 0, premiumDiscountPercent: 15 });
  });
  it('replaces a store-subscriber price entirely (never stacked, not "best of")', () => {
    const l = line({ originalPrice: 100, price: 95, totalPrice: 190, subscriberDiscountUSD: 10 }); // 5% subscriber price
    const r = applyPremiumToLine(l, { price: 100, compareAtPrice: null }, 20, T0);
    expect(r.replacedSubscriberDiscount).toBe(10);
    expect(l.totalPrice).toBe(160); // 20% off LIST, not 20% on top of the subscriber price
    expect(l.subscriberDiscountUSD).toBe(0);
  });
  it('a BETTER subscriber price stays: the member is never charged more than the buyer already pays', () => {
    const l = line({ originalPrice: 100, price: 70, totalPrice: 140, subscriberDiscountUSD: 60 });
    expect(applyPremiumToLine(l, { price: 100, compareAtPrice: null }, 20, T0).applied).toBe(false);
    expect(l.totalPrice).toBe(140);
  });
  it('leaves the line untouched when premium would not beat the normal price, or the seller gives 0%', () => {
    const l = line({ price: 90, totalPrice: 180 });
    expect(applyPremiumToLine(l, variant, 5, T0).applied).toBe(false);
    expect(l.totalPrice).toBe(180);
    expect(applyPremiumToLine(l, variant, 0, T5).applied).toBe(false);
    expect(l.premiumFeePercent).toBeUndefined();
  });
  it('premiumUnitPrice rounds to cents', () => {
    expect(premiumUnitPrice(9.99, 15)).toBe(8.49);
  });
});

describe('Premium settings (R4)', () => {
  it('defaults: platform 5% on, fee 5%, gap 5; disabled platform = 0 effective', () => {
    expect(termsFromSettings()).toEqual({ platformEnabled: true, platformPercent: 5, sellerFeePercent: 5, minGapPercent: 5 });
    expect(T0).toMatchObject({ platformEnabled: false, platformPercent: 0 });
  });
  it('cleanPremiumSettings merges, validates ranges (platform 0-30, fee 0-30, gap 0-50)', () => {
    const cur = { platformDiscount: { enabled: true, percent: 5 }, premiumSellerFeePercent: 5, minGapPercent: 5 };
    expect(cleanPremiumSettings({ platformDiscount: { enabled: false } }, cur)).toEqual({ ...cur, platformDiscount: { enabled: false, percent: 5 } });
    expect(cleanPremiumSettings({ premiumSellerFeePercent: 7.5, minGapPercent: 0 }, cur)).toMatchObject({ premiumSellerFeePercent: 7.5, minGapPercent: 0 });
    for (const bad of [{ platformDiscount: { percent: 31 } }, { platformDiscount: { percent: -1 } }, { premiumSellerFeePercent: 31 }, { minGapPercent: 51 }, { premiumSellerFeePercent: 'x' }, { platformDiscount: 'x' }]) {
      expect(() => cleanPremiumSettings(bad, cur)).toThrow(BadRequestException);
    }
  });
});

describe('premiumGapViolation (R3)', () => {
  it('premium 15, gap 5: a 10% sale is fine, 12% is not (exact seller message)', () => {
    expect(premiumGapViolation(15, [{ price: 90, compareAtPrice: 100 }], 5)).toBeNull();
    expect(premiumGapViolation(15, [{ price: 88, compareAtPrice: 100 }], 5)).toBe(
      'Your normal sale is 12% but your Premium discount is 15%. Premium must be at least 5 points better - lower the sale to 10% or raise Premium to 17%.');
  });
  it('no premium or no sale -> nothing to check; the worst variant counts', () => {
    expect(premiumGapViolation(0, [{ price: 50, compareAtPrice: 100 }], 5)).toBeNull();
    expect(premiumGapViolation(15, [{ price: 100, compareAtPrice: null }], 5)).toBeNull();
    expect(premiumGapViolation(15, [{ price: 95, compareAtPrice: 100 }, { price: 80, compareAtPrice: 100 }], 5)).toContain('normal sale is 20%');
  });
  it('a premium percent at or below the gap allows no sale at all', () => {
    expect(premiumGapViolation(5, [{ price: 99, compareAtPrice: 100 }], 5)).toContain('lower the sale to 0%');
  });
});
describe('periods', () => {
  it('adds a calendar month / year, clamping the day', () => {
    expect(addPeriod(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addPeriod(new Date('2026-10-13T00:00:00Z'), 'monthly').toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(addPeriod(new Date('2026-10-13T00:00:00Z'), 'yearly').toISOString()).toBe('2027-10-13T00:00:00.000Z');
    expect(addPeriod(new Date('2026-12-15T00:00:00Z'), 'monthly').toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
  it('monthKey is UTC YYYY-MM', () => {
    expect(monthKey(new Date('2026-03-31T23:59:59Z'))).toBe('2026-03');
  });
});
