import { CAMPAIGN_WITHIN_CAP, campaignHasBudget } from './schemas/campaign.schema';
import { MarketingService } from './marketing.service';

describe('campaign subsidy cap', () => {
  it('a platform campaign stops once the spent total reaches the cap', () => {
    expect(campaignHasBudget({ sponsorType: 'platform', subsidyCapUSD: 100, totalPlatformSubsidyUSD: 99.99 })).toBe(true);
    expect(campaignHasBudget({ sponsorType: 'platform', subsidyCapUSD: 100, totalPlatformSubsidyUSD: 100 })).toBe(false);
    expect(campaignHasBudget({ sponsorType: 'platform', subsidyCapUSD: 100, totalPlatformSubsidyUSD: 250 })).toBe(false);
  });

  it('no cap (null / 0 / missing) and seller-sponsored campaigns are never stopped', () => {
    expect(campaignHasBudget({ sponsorType: 'platform', subsidyCapUSD: null, totalPlatformSubsidyUSD: 9999 })).toBe(true);
    expect(campaignHasBudget({ sponsorType: 'platform', subsidyCapUSD: 0, totalPlatformSubsidyUSD: 9999 })).toBe(true);
    expect(campaignHasBudget({ sponsorType: 'platform', totalPlatformSubsidyUSD: 5 })).toBe(true);
    expect(campaignHasBudget({ sponsorType: 'seller', subsidyCapUSD: 1, totalPlatformSubsidyUSD: 50 })).toBe(true);
  });

  it('the Mongo fragment encodes the same rule', () => {
    const inner = (CAMPAIGN_WITHIN_CAP.$expr.$not[0] as any).$and;
    expect(inner).toHaveLength(3);
    expect(JSON.stringify(inner)).toContain('"$subsidyCapUSD"');
    expect(JSON.stringify(inner)).toContain('"platform"');
  });

  it('active-campaign lookups (cart, checkout, badges) always apply the cap filter', async () => {
    const find = jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }), sort: () => ({ lean: () => Promise.resolve([]) }) });
    const db: any = { repositories: { campaignModel: { find }, storeModel: { countDocuments: jest.fn() } } };
    const svc = new MarketingService(db, { log: jest.fn() } as any);
    await svc.getActiveCampaignsForStores(['s1']);
    expect(find.mock.calls[0][0].$expr).toEqual(CAMPAIGN_WITHIN_CAP.$expr);
    await svc.getPublicActiveCampaigns();
    expect(find.mock.calls[1][0].$expr).toEqual(CAMPAIGN_WITHIN_CAP.$expr);
  });
});
