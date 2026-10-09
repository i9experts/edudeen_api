import { resolveCartCampaignDiscount } from './campaign-pricing.util';

const end = new Date('2026-12-01T00:00:00Z');
const camp = (over: any = {}) => ({ _id: 'c1', name: 'Eid Sale', discountType: 'percentage', discountValue: 10, currency: 'USD', endDate: end, sponsorType: 'platform', ...over });
const usdToPkr = jest.fn(async (amount: number, from: string, to: string) => (from === 'USD' && to === 'PKR' ? amount * 280 : amount));

describe('resolveCartCampaignDiscount', () => {
  beforeEach(() => usdToPkr.mockClear());

  it('reports a PKR cart in PKR even though the campaign document says USD', async () => {
    const r = await resolveCartCampaignDiscount([camp()], 2000, 'PKR', usdToPkr);
    expect(r).toMatchObject({ amount: 200, currency: 'PKR', discountType: 'percentage', discountValue: 10, valueCurrency: null });
    expect(usdToPkr).not.toHaveBeenCalled(); // a percentage needs no conversion
  });

  it('converts a fixed USD value into the cart currency and keeps the original value for display', async () => {
    const r = await resolveCartCampaignDiscount([camp({ discountType: 'fixed', discountValue: 5 })], 5000, 'PKR', usdToPkr);
    expect(r).toMatchObject({ amount: 1400, currency: 'PKR', discountType: 'fixed', discountValue: 5, valueCurrency: 'USD' });
  });

  it('caps a fixed discount at the subtotal', async () => {
    const r = await resolveCartCampaignDiscount([camp({ discountType: 'fixed', discountValue: 5 })], 1000, 'PKR', usdToPkr);
    expect(r?.amount).toBe(1000);
  });

  it('treats a missing campaign currency as USD and needs no conversion for a USD cart', async () => {
    const r = await resolveCartCampaignDiscount([camp({ discountType: 'fixed', discountValue: 5, currency: null })], 40, 'USD', usdToPkr);
    expect(r).toMatchObject({ amount: 5, currency: 'USD', valueCurrency: 'USD' });
    expect(usdToPkr).not.toHaveBeenCalled();
  });

  it('leaves out a fixed sale it cannot convert (no converter, or no rate) instead of showing a wrong amount', async () => {
    expect(await resolveCartCampaignDiscount([camp({ discountType: 'fixed', discountValue: 5 })], 5000, 'PKR')).toBeNull();
    const broken = jest.fn(async () => { throw new Error('no rate'); });
    expect(await resolveCartCampaignDiscount([camp({ discountType: 'fixed', discountValue: 5 })], 5000, 'PKR', broken)).toBeNull();
    // ...but a percentage campaign alongside it still applies
    const r = await resolveCartCampaignDiscount([camp({ _id: 'a', discountType: 'fixed', discountValue: 5 }), camp({ _id: 'b', name: 'Pct' })], 5000, 'PKR', broken);
    expect(r).toMatchObject({ campaignId: 'b', amount: 500, currency: 'PKR' });
  });

  it('picks the sale that saves the most and returns null for none or a badge-only campaign', async () => {
    const r = await resolveCartCampaignDiscount([camp({ _id: 'a', discountValue: 5 }), camp({ _id: 'b', discountValue: 20 })], 1000, 'PKR', usdToPkr);
    expect(r?.campaignId).toBe('b');
    expect(await resolveCartCampaignDiscount([], 1000, 'PKR', usdToPkr)).toBeNull();
    expect(await resolveCartCampaignDiscount([camp({ discountType: null, discountValue: null })], 1000, 'PKR', usdToPkr)).toBeNull();
  });
});
