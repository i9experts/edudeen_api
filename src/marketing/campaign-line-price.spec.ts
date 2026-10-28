import {
  ActiveCampaignForStore, applyCampaignsToVariants, campaignLinePrice, campaignListUnit, pickBestCampaignForLine,
} from './campaign-pricing.util';

const camp = (id: string, over: Partial<ActiveCampaignForStore> = {}): ActiveCampaignForStore => ({
  campaignId: id, name: id, discountType: 'percentage', discountValue: 10, currency: 'USD',
  endDate: new Date('2030-01-01'), sponsorType: 'platform', ...over,
});

describe('campaign price is computed from the LIST price (owner rule R1)', () => {
  it('list = compare-at when above the price, else the price', () => {
    expect(campaignListUnit(500, 550)).toBe(550);
    expect(campaignListUnit(500, 500)).toBe(500);
    expect(campaignListUnit(500, 400)).toBe(500);
    expect(campaignListUnit(500, null)).toBe(500);
  });
  it('price 500 / compare 550, 10% => buyer pays 495 (not 450); discount vs normal price = 5', () => {
    const r = campaignLinePrice(camp('X'), 500, 550)!;
    expect(r.listUnit).toBe(550);
    expect(r.unit).toBe(495);
    expect(r.discount).toBe(5);
  });
  it('price 500 / compare 550, 5% => 522.5: the seller\'s own sale is SUSPENDED, the sale price applies even though it is dearer', () => {
    const r = campaignLinePrice(camp('X', { discountValue: 5 }), 500, 550)!;
    expect(r.unit).toBe(522.5);
    expect(r.discount).toBe(-22.5);   // vs the seller's own price
    expect(r.sponsored).toBe(27.5);   // off the list price: what the platform reimburses / the seller gives up
    expect(r.replacesSellerSale).toBe(true);
  });
  it('without a seller sale a tie stays normal (the campaign price equal to the price does not apply)', () => {
    // list 500 (no compare-at), fixed 0 => unit 500, equal to the price
    expect(campaignLinePrice(camp('X', { discountType: 'fixed', discountValue: 0 }), 500, null)).toBeNull();
  });
  it('seller sale + fixed 50 => 500: applies (suspends the sale), buyer pays the same, platform covers 50 off list', () => {
    const r = campaignLinePrice(camp('X', { discountType: 'fixed', discountValue: 50 }), 500, 550)!;
    expect(r.unit).toBe(500);
    expect(r.discount).toBe(0);
    expect(r.sponsored).toBe(50);
  });
  it('a store-subscriber price keeps the old "only if cheaper" rule even when the seller has a sale', () => {
    expect(campaignLinePrice(camp('X', { discountValue: 5 }), 500, 550, 480)).toBeNull(); // 522.5 > 480
    const r = campaignLinePrice(camp('X', { discountValue: 20 }), 500, 550, 480)!;        // 440 < 480
    expect(r.replacesSellerSale).toBe(false);
    expect(r.discount).toBe(40);
    expect(r.sponsored).toBe(40);
  });
  it('fixed amount: list - amount, same rule', () => {
    const r = campaignLinePrice(camp('X', { discountType: 'fixed', discountValue: 60 }), 500, 550)!;
    expect(r.unit).toBe(490);
    expect(r.discount).toBe(10);
  });
  it('no compare-at: plain percentage of the price', () => {
    const r = campaignLinePrice(camp('X', { discountValue: 20 }), 100, null)!;
    expect(r.unit).toBe(80);
    expect(r.discount).toBe(20);
  });
  it('a badge-only campaign (no discount) never changes a price', () => {
    expect(campaignLinePrice(camp('X', { discountType: null, discountValue: null }), 100, null)).toBeNull();
  });
  it('the normal price may be lower than the selling price (subscriber price): the campaign must beat that', () => {
    expect(campaignLinePrice(camp('X', { discountValue: 10 }), 100, null, 85)).toBeNull(); // 90 > 85
    expect(campaignLinePrice(camp('X', { discountValue: 20 }), 100, null, 85)!.discount).toBe(5); // 80 vs 85
  });
  it('best of several campaigns = lowest unit; tie -> soonest-ending', () => {
    const a = camp('A', { discountValue: 10 });
    const b = camp('B', { discountValue: 20 });
    expect(pickBestCampaignForLine([a, b], 100, null)!.campaign.campaignId).toBe('B');
    const c = camp('C', { discountValue: 20, endDate: new Date('2029-01-01') });
    expect(pickBestCampaignForLine([b, c], 100, null)!.campaign.campaignId).toBe('C');
    expect(pickBestCampaignForLine([], 100, null)).toBeNull();
  });
});

describe('seller credit under a campaign (R1): discount recorded = normal price - campaign price', () => {
  // The checkout stores campaignDiscountUSD = discount x qty. PaymentService credits the seller subtotal (what the buyer
  // paid) + platform-sponsored discount, so: platform => 495 + 5 = 500 (their own price); seller-sponsored => 495.
  it('platform-sponsored: buyer 495 + platform 5 = seller 500; seller-sponsored: seller 495', () => {
    const r = campaignLinePrice(camp('X'), 500, 550)!;
    expect(r.unit + r.discount).toBe(500);
    expect(r.unit).toBe(495);
  });
  it('seller sale suspended: platform-sponsored seller is credited the LIST price (buyer unit + sponsored), seller-sponsored gets the buyer unit', () => {
    const r = campaignLinePrice(camp('X', { discountValue: 5 }), 500, 550)!;
    expect(r.unit + r.sponsored).toBe(550);
    expect(r.unit).toBe(522.5);
  });
});

describe('applyCampaignsToVariants (list / detail display)', () => {
  const variants = [{ _id: 'v1', price: 500, compareAtPrice: 550 }, { _id: 'v2', price: 400, compareAtPrice: null }];
  it('stamps campaignPrice per variant and hides the seller markdown only where the sale applies', () => {
    const r = applyCampaignsToVariants([camp('X')], variants);
    expect(r.variants[0]).toMatchObject({ campaignPrice: 495, campaignId: 'X', campaignListPrice: 550, compareAtPrice: null, originalCompareAtPrice: 550 });
    expect(r.variants[1]).toMatchObject({ campaignPrice: 360 });
    expect(r.primary?.campaignId).toBe('X');
    expect(r.appliedPrice).toBe(360);
  });
  it('5% on 500/550: the sale price 522.5 replaces the seller\'s own sale (markdown hidden)', () => {
    const r = applyCampaignsToVariants([camp('X', { discountValue: 5 })], [variants[0]]);
    expect(r.variants[0]).toMatchObject({ campaignPrice: 522.5, compareAtPrice: null, originalCompareAtPrice: 550 });
    expect(r.primary?.campaignId).toBe('X');
    expect(r.appliedPrice).toBe(522.5);
  });
  it('no campaigns -> nothing changes', () => {
    const r = applyCampaignsToVariants([], variants);
    expect(r.variants).toEqual(variants);
    expect(r.primary).toBeNull();
  });
});
