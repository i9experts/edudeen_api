import { ActiveCampaignForStore } from './campaign-pricing.util';
import { resolveCartCampaignDiscount } from './campaign-pricing.util';
import { campaignsForProduct, isProductInCampaign, loadCampaignContext, parseCampaignIdsInput } from './campaign-eligibility.util';

const camp = (id: string, over: Partial<ActiveCampaignForStore> = {}): ActiveCampaignForStore => ({
  campaignId: id, name: id, discountType: 'percentage', discountValue: 20, currency: 'USD',
  endDate: new Date('2030-01-01'), sponsorType: 'seller', ...over,
});

describe('isProductInCampaign / campaignsForProduct (strict per-product opt-in)', () => {
  it('a product that never ticked the campaign is NOT in it (no whole-store fallback)', () => {
    expect(isProductInCampaign('X', [])).toBe(false);
    expect(isProductInCampaign('X', undefined)).toBe(false);
    expect(isProductInCampaign('X', null)).toBe(false);
  });
  it('only the ticked campaign counts', () => {
    expect(isProductInCampaign('X', ['X'])).toBe(true);
    expect(isProductInCampaign('X', ['Y'])).toBe(false);
  });
  it('campaignsForProduct filters per campaign', () => {
    const list = [camp('X'), camp('Z')];
    expect(campaignsForProduct(list, ['X']).map((c) => c.campaignId)).toEqual(['X']);
    expect(campaignsForProduct(list, ['X', 'Z']).map((c) => c.campaignId)).toEqual(['X', 'Z']);
    expect(campaignsForProduct(list, [])).toEqual([]);
    expect(campaignsForProduct(undefined, ['X'])).toEqual([]);
  });
});

describe('resolveCartCampaignDiscount with per-campaign subtotal', () => {
  it('values the campaign on the eligible lines only', async () => {
    const raw = [{ _id: 'X', name: 'X', discountType: 'percentage', discountValue: 20, endDate: new Date('2030-01-01'), sponsorType: 'seller' }];
    const r = await resolveCartCampaignDiscount(raw, 200, 'USD', undefined, () => 100);
    expect(r?.amount).toBe(20);
  });
});

describe('parseCampaignIdsInput / loadCampaignContext', () => {
  const id = 'a'.repeat(24);
  it('accepts a clean list, de-duplicates, rejects malformed', () => {
    expect(parseCampaignIdsInput([id, id])).toEqual([id]);
    expect(parseCampaignIdsInput([])).toEqual([]);
    expect(parseCampaignIdsInput('x')).toBeNull();
    expect(parseCampaignIdsInput([1])).toBeNull();
    expect(parseCampaignIdsInput(['nope'])).toBeNull();
    expect(parseCampaignIdsInput(Array.from({ length: 11 }, (_, i) => String(i).padStart(24, '0')))).toBeNull();
  });
  it('makes no query when there is nothing to look up', async () => {
    const model = { find: jest.fn() };
    const ctx = await loadCampaignContext(model, []);
    expect(ctx.campaignIdsByProduct.size).toBe(0);
    expect(model.find).not.toHaveBeenCalled();
  });
  it('builds the per-product lists', async () => {
    const model = {
      find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'p1', campaignIds: ['X'] }, { _id: 'p2' }]) }) }),
    };
    const ctx = await loadCampaignContext(model, ['p1', 'p2']);
    expect(ctx.campaignIdsByProduct.get('p1')).toEqual(['X']);
    expect(ctx.campaignIdsByProduct.get('p2')).toEqual([]);
  });
});
