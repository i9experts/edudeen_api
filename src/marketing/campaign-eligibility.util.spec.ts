import { ActiveCampaignForStore } from './campaign-pricing.util';
import { resolveCartCampaignDiscount } from './campaign-pricing.util';
import {
  campaignsForProduct, isProductInCampaign, loadCampaignContext, parseCampaignIdsInput, pickBestCampaignForItems, selectionKey,
} from './campaign-eligibility.util';

const camp = (id: string, over: Partial<ActiveCampaignForStore> = {}): ActiveCampaignForStore => ({
  campaignId: id, name: id, discountType: 'percentage', discountValue: 20, currency: 'USD',
  endDate: new Date('2030-01-01'), sponsorType: 'seller', ...over,
});
const items = [
  { productId: 'A', amount: 100 },
  { productId: 'B', amount: 50 },
  { productId: 'C', amount: 50 },
];

describe('isProductInCampaign / campaignsForProduct', () => {
  it('legacy: store with no selection for the campaign -> every product is in', () => {
    expect(isProductInCampaign('X', 's1', [], new Set())).toBe(true);
    expect(isProductInCampaign('X', 's1', undefined, new Set())).toBe(true);
  });
  it('store with a selection -> only the ticked products', () => {
    const sel = new Set([selectionKey('s1', 'X')]);
    expect(isProductInCampaign('X', 's1', ['X'], sel)).toBe(true);
    expect(isProductInCampaign('X', 's1', [], sel)).toBe(false);
    expect(isProductInCampaign('X', 's1', ['Y'], sel)).toBe(false);
  });
  it('a selection in another store or for another campaign does not change this one', () => {
    const sel = new Set([selectionKey('s2', 'X'), selectionKey('s1', 'Y')]);
    expect(isProductInCampaign('X', 's1', [], sel)).toBe(true);
  });
  it('campaignsForProduct filters per campaign', () => {
    const sel = new Set([selectionKey('s1', 'X')]);
    const list = [camp('X'), camp('Z')];
    expect(campaignsForProduct(list, 's1', ['X'], sel).map((c) => c.campaignId)).toEqual(['X', 'Z']);
    expect(campaignsForProduct(list, 's1', [], sel).map((c) => c.campaignId)).toEqual(['Z']);
    expect(campaignsForProduct(undefined, 's1', [], sel)).toEqual([]);
  });
});

describe('pickBestCampaignForItems', () => {
  it('percentage on the selected product only', () => {
    const sel = new Set([selectionKey('s1', 'X')]);
    const r = pickBestCampaignForItems([camp('X')], 's1', items, new Map([['A', ['X']]]), sel)!;
    expect(r.discountAmount).toBe(20); // 20% of A (100), not of the 200 subtotal
    expect(r.productIds).toEqual(['A']);
  });
  it('fixed amount is capped by the eligible subtotal', () => {
    const sel = new Set([selectionKey('s1', 'X')]);
    const r = pickBestCampaignForItems([camp('X', { discountType: 'fixed', discountValue: 80 })], 's1', items, new Map([['B', ['X']]]), sel)!;
    expect(r.discountAmount).toBe(50);
    expect(r.productIds).toEqual(['B']);
  });
  it('legacy store without any selection: whole cart', () => {
    const r = pickBestCampaignForItems([camp('X')], 's1', items, new Map(), new Set())!;
    expect(r.discountAmount).toBe(40);
    expect(r.productIds).toEqual(['A', 'B', 'C']);
  });
  it('two campaigns with different selections: each valued on its own set, best wins', () => {
    const sel = new Set([selectionKey('s1', 'X'), selectionKey('s1', 'Y')]);
    const own = new Map([['A', ['X']], ['B', ['Y']], ['C', ['Y']]]);
    const r = pickBestCampaignForItems([camp('X', { discountValue: 30 }), camp('Y', { discountValue: 20 })], 's1', items, own, sel)!;
    // X: 30% of 100 = 30 ; Y: 20% of 100 = 20
    expect(r.campaign.campaignId).toBe('X');
    expect(r.discountAmount).toBe(30);
    expect(r.productIds).toEqual(['A']);
    const r2 = pickBestCampaignForItems([camp('X', { discountValue: 10 }), camp('Y', { discountValue: 20 })], 's1', items, own, sel)!;
    expect(r2.campaign.campaignId).toBe('Y');
    expect(r2.productIds).toEqual(['B', 'C']);
  });
  it('no eligible line -> null', () => {
    const sel = new Set([selectionKey('s1', 'X')]);
    expect(pickBestCampaignForItems([camp('X')], 's1', items, new Map(), sel)).toBeNull();
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
  it('makes no query when there is no campaign', async () => {
    const model = { aggregate: jest.fn(), find: jest.fn() };
    const ctx = await loadCampaignContext(model, ['s1'], [], ['p1']);
    expect(ctx.selection.size).toBe(0);
    expect(model.aggregate).not.toHaveBeenCalled();
  });
  it('builds the selection set and per-product lists', async () => {
    const model = {
      aggregate: jest.fn().mockResolvedValue([{ _id: { s: 's1', c: 'X' } }]),
      find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'p1', campaignIds: ['X'] }, { _id: 'p2' }]) }) }),
    };
    const ctx = await loadCampaignContext(model, ['s1'], ['X'], ['p1', 'p2']);
    expect(ctx.selection.has(selectionKey('s1', 'X'))).toBe(true);
    expect(ctx.campaignIdsByProduct.get('p1')).toEqual(['X']);
    expect(ctx.campaignIdsByProduct.get('p2')).toEqual([]);
  });
});
