/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProductOffersService, normaliseBulkOffers } from './product-offers.service';
import { assertOfferExclusive, OFFER_CONFLICT_MESSAGE, premiumFieldsFromBody } from './offers.util';
import { premiumPercentFor, termsFromSettings } from '../premium/premium.util';

const STORE = '64f0c0ffee0c0ffee0c0ff0a';
const SELLER = 'seller1';
const id = (n: number) => `64f0c0ffee0c0ffee0c0fb${String(n).padStart(2, '0')}`;
const CAMP = '64f0c0ffee0c0ffee0c0fc01';
const chain = (v: any) => { const c: any = { select: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };

function setup(opts: { products?: any[]; variants?: any[]; owner?: boolean; campaignOk?: boolean } = {}) {
  const products = opts.products ?? [{ _id: id(1), name: 'A', campaignIds: [] }, { _id: id(2), name: 'B', campaignIds: [] }];
  const bulkWrite = jest.fn().mockResolvedValue({});
  const repos: any = {
    storeModel: { findOne: jest.fn(() => chain(opts.owner === false ? null : { _id: STORE, sellerId: SELLER })), findById: jest.fn(() => chain(opts.owner === false ? null : { _id: STORE, sellerId: SELLER })) },
    productModel: { find: jest.fn(() => chain(products)), bulkWrite },
    productVariantModel: { find: jest.fn(() => chain(opts.variants ?? [])) },
  };
  const marketing: any = { resolveProductCampaignIds: jest.fn().mockResolvedValue(opts.campaignOk === false ? [] : [CAMP]) };
  const premium: any = { getTerms: jest.fn().mockResolvedValue(termsFromSettings({ platformDiscount: { enabled: false, percent: 5 } })) };
  const log = jest.fn();
  const svc = new ProductOffersService({ repositories: repos } as any, { log } as any, marketing, premium);
  return { svc, bulkWrite, repos, marketing };
}

describe('normaliseBulkOffers', () => {
  const base = { storeId: STORE, productIds: [id(1)], action: 'premium_off' };
  it('validates store, ids, action and the per-action fields', () => {
    expect(normaliseBulkOffers(base).action).toBe('premium_off');
    expect(() => normaliseBulkOffers({ ...base, storeId: 'x' })).toThrow(BadRequestException);
    expect(() => normaliseBulkOffers({ ...base, productIds: [] })).toThrow(BadRequestException);
    expect(() => normaliseBulkOffers({ ...base, productIds: ['nope'] })).toThrow(BadRequestException);
    expect(() => normaliseBulkOffers({ ...base, action: 'delete_all' })).toThrow(BadRequestException);
    expect(() => normaliseBulkOffers({ ...base, action: 'premium_on' })).toThrow(BadRequestException); // percent missing
    expect(() => normaliseBulkOffers({ ...base, action: 'premium_on', percent: 51 })).toThrow(BadRequestException);
    expect(() => normaliseBulkOffers({ ...base, action: 'premium_on', percent: 0 })).toThrow(BadRequestException);
    expect(normaliseBulkOffers({ ...base, action: 'premium_on', percent: 15 }).percent).toBe(15);
    expect(() => normaliseBulkOffers({ ...base, action: 'campaign_add' })).toThrow(BadRequestException); // campaignId missing
  });
  it('limit: at most 200 products; duplicates are collapsed', () => {
    const many = Array.from({ length: 201 }, (_, i) => id(i));
    expect(() => normaliseBulkOffers({ ...base, productIds: many })).toThrow(BadRequestException);
    const ok = Array.from({ length: 200 }, (_, i) => `64f0c0ffee0c0ffee0c1${String(i).padStart(4, '0')}`);
    expect(normaliseBulkOffers({ ...base, productIds: ok }).productIds).toHaveLength(200);
    expect(normaliseBulkOffers({ ...base, productIds: [id(1), id(1)] }).productIds).toEqual([id(1)]);
  });
});

describe('ProductOffersService.bulkOffers', () => {
  it('ownership: a store the seller does not own is rejected and nothing is written', async () => {
    const { svc, bulkWrite } = setup({ owner: false });
    await expect(svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'premium_off' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(bulkWrite).not.toHaveBeenCalled();
  });
  it('products are looked up by store AND seller; ids not found are skipped with a reason', async () => {
    const { svc, repos, bulkWrite } = setup();
    const r: any = await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1), id(99)], action: 'premium_off' });
    expect(repos.productModel.find.mock.calls[0][0]).toMatchObject({ storeId: STORE, sellerId: SELLER, isDelete: false });
    expect(r.data.updated).toEqual([id(1)]);
    expect(r.data.skipped).toEqual([{ id: id(99), reason: expect.any(String) }]);
    expect(bulkWrite).toHaveBeenCalledTimes(1);
  });
  it('premium_on: sets percent, clears opt-out and leaves every platform sale (exclusivity)', async () => {
    const { svc, bulkWrite } = setup({ products: [{ _id: id(1), name: 'A', campaignIds: [CAMP] }] });
    await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'premium_on', percent: 15 });
    expect(bulkWrite.mock.calls[0][0][0].updateOne.update).toEqual({ $set: { premiumDiscountPercent: 15, premiumOptOut: false, campaignIds: [] } });
  });
  it('premium_on: a product whose normal sale is within the min gap of the percent is SKIPPED (batch continues)', async () => {
    const variants = [{ productId: id(1), price: 90, compareAtPrice: 100 }, { productId: id(2), price: 100, compareAtPrice: null }]; // A has a 10% sale
    const { svc, bulkWrite } = setup({ variants });
    const r: any = await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1), id(2)], action: 'premium_on', percent: 12 }); // 12 - 5 gap = 7 < 10
    expect(r.data.updated).toEqual([id(2)]);
    expect(r.data.skipped[0]).toMatchObject({ id: id(1) });
    expect(r.data.skipped[0].reason).toMatch(/normal sale is 10%/);
    expect(bulkWrite.mock.calls[0][0]).toHaveLength(1);
  });
  it('premium_off: percent cleared and premiumOptOut = true', async () => {
    const { svc, bulkWrite } = setup();
    await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'premium_off' });
    expect(bulkWrite.mock.calls[0][0][0].updateOne.update).toEqual({ $set: { premiumDiscountPercent: null, premiumOptOut: true } });
  });
  it('campaign_add: adds the campaign and sets premiumOptOut = true (exclusivity); an unavailable campaign is a 400', async () => {
    const { svc, bulkWrite } = setup();
    await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'campaign_add', campaignId: CAMP });
    expect(bulkWrite.mock.calls[0][0][0].updateOne.update).toEqual({ $addToSet: { campaignIds: CAMP }, $set: { premiumOptOut: true, premiumDiscountPercent: null } });
    const bad = setup({ campaignOk: false });
    await expect(bad.svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'campaign_add', campaignId: CAMP })).rejects.toBeInstanceOf(BadRequestException);
    expect(bad.bulkWrite).not.toHaveBeenCalled();
  });
  it('campaign_add: a product already in 10 sales is skipped', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `64f0c0ffee0c0ffee0c0fd${String(i).padStart(2, '0')}`);
    const { svc } = setup({ products: [{ _id: id(1), name: 'A', campaignIds: ten }] });
    const r: any = await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'campaign_add', campaignId: CAMP });
    expect(r.data.updated).toEqual([]);
    expect(r.data.skipped).toHaveLength(1);
  });
  it('campaign_remove: pulls the campaign, no premium change', async () => {
    const { svc, bulkWrite } = setup();
    await svc.bulkOffers(SELLER, { storeId: STORE, productIds: [id(1)], action: 'campaign_remove', campaignId: CAMP });
    expect(bulkWrite.mock.calls[0][0][0].updateOne.update).toEqual({ $pull: { campaignIds: CAMP } });
  });
});

describe('offer exclusivity helpers (R3)', () => {
  const storeOn = { premiumDiscount: { enabled: true, percent: 10 } };
  it('premiumOptOut turns the effective Premium percent off (store default and product override)', () => {
    expect(premiumPercentFor({ premiumDiscountPercent: null }, storeOn)).toBe(10);
    expect(premiumPercentFor({ premiumDiscountPercent: null, premiumOptOut: true }, storeOn)).toBe(0);
    expect(premiumPercentFor({ premiumDiscountPercent: 20, premiumOptOut: true }, storeOn)).toBe(0);
  });
  it('a campaign + an effective Premium offer is a 400 with the owner message; opting out (or no premium) is fine', () => {
    expect(() => assertOfferExclusive(storeOn, { premiumDiscountPercent: null, premiumOptOut: false, campaignIds: [CAMP] })).toThrow(OFFER_CONFLICT_MESSAGE);
    expect(() => assertOfferExclusive(storeOn, { premiumDiscountPercent: 15, campaignIds: [CAMP] })).toThrow(BadRequestException);
    expect(() => assertOfferExclusive(storeOn, { premiumDiscountPercent: null, premiumOptOut: true, campaignIds: [CAMP] })).not.toThrow();
    expect(() => assertOfferExclusive({ premiumDiscount: null }, { premiumDiscountPercent: null, campaignIds: [CAMP] })).not.toThrow();
    expect(() => assertOfferExclusive(storeOn, { premiumDiscountPercent: 15, premiumOptOut: false, campaignIds: [] })).not.toThrow();
  });
  it('body parsing: a percent turns the opt-out off; explicit opt-out wins; junk is a 400', () => {
    expect(premiumFieldsFromBody({ premiumDiscountPercent: 15 })).toEqual({ premiumDiscountPercent: 15, premiumOptOut: false });
    expect(premiumFieldsFromBody({ premiumDiscountPercent: null, premiumOptOut: true })).toEqual({ premiumDiscountPercent: null, premiumOptOut: true });
    expect(premiumFieldsFromBody({})).toEqual({});
    expect(() => premiumFieldsFromBody({ premiumOptOut: 'yes' })).toThrow(BadRequestException);
  });
});
