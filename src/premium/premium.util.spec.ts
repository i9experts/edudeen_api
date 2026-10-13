import { BadRequestException } from '@nestjs/common';
import { addPeriod, applyPremiumToLine, cleanPremiumPercent, cleanStorePremiumDiscount, monthKey, premiumPercentFor, premiumUnitPrice } from './premium.util';

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

describe('applyPremiumToLine - best single seller-side discount per line', () => {
  it('discounts a plain line', () => {
    const l = line();
    const r = applyPremiumToLine(l, 20);
    expect(r.discount).toBe(40);
    expect(l.price).toBe(80);
    expect(l.totalPrice).toBe(160);
    expect(l).toMatchObject({ premiumDiscountUSD: 40, premiumDiscountPercent: 20, originalPrice: 100 });
  });
  it('never stacks on a campaign or an automatic discount', () => {
    const c = line({ campaignDiscountUSD: 10, totalPrice: 190 });
    expect(applyPremiumToLine(c, 20).discount).toBe(0);
    expect(c.totalPrice).toBe(190);
    const a = line({ autoDiscountUSD: 10, totalPrice: 190 });
    expect(applyPremiumToLine(a, 20).discount).toBe(0);
    expect(a.totalPrice).toBe(190);
  });
  it('keeps a better subscriber price (no stacking) and replaces a worse one', () => {
    const better = line({ originalPrice: 100, price: 70, totalPrice: 140, subscriberDiscountUSD: 60 }); // 30% member price
    expect(applyPremiumToLine(better, 20).discount).toBe(0);
    expect(better.totalPrice).toBe(140);
    const worse = line({ originalPrice: 100, price: 95, totalPrice: 190, subscriberDiscountUSD: 10 }); // 5%
    const r = applyPremiumToLine(worse, 20);
    expect(r.discount).toBe(40); // measured from the LIST price, not 95
    expect(r.replacedSubscriberDiscount).toBe(10);
    expect(worse.totalPrice).toBe(160); // 20% off list, not 20% on top of 5%
    expect(worse.subscriberDiscountUSD).toBe(0);
  });
  it('0% does nothing', () => {
    const l = line();
    expect(applyPremiumToLine(l, 0).discount).toBe(0);
    expect(l.totalPrice).toBe(200);
  });
  it('premiumUnitPrice rounds to cents', () => {
    expect(premiumUnitPrice(9.99, 15)).toBe(8.49);
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
