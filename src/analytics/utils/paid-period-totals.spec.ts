import { paidPeriodTotals, pktDayStart } from './order-aggregation.util';

describe('pktDayStart', () => {
  it('starts the Pakistan day at 19:00 UTC the evening before', () => {
    // 02:00 PKT on 5 Nov = 21:00 UTC on 4 Nov -> day started 00:00 PKT 5 Nov = 19:00 UTC 4 Nov
    expect(pktDayStart(new Date('2026-11-04T21:00:00Z')).toISOString()).toBe('2026-11-04T19:00:00.000Z');
    // 12:00 UTC 5 Nov = 17:00 PKT 5 Nov -> same PKT day
    expect(pktDayStart(new Date('2026-11-05T12:00:00Z')).toISOString()).toBe('2026-11-04T19:00:00.000Z');
  });
});

describe('paidPeriodTotals', () => {
  const model = (row: any) => ({ aggregate: jest.fn().mockResolvedValue(row ? [row] : []) }) as any;

  it('returns zeros (and no AOV) when nothing is paid', async () => {
    const r = await paidPeriodTotals(model(null), new Date(), new Date());
    expect(r).toEqual({ orderCount: 0, netRevenue: 0, avgOrderValue: 0, freeClaims: 0 });
  });

  it('reports paid orders, AOV and free claims separately', async () => {
    const r = await paidPeriodTotals(model({ paidCount: 2, gross: 30, refunds: 10, freeClaims: 3 }), new Date(), new Date());
    expect(r).toEqual({ orderCount: 2, netRevenue: 20, avgOrderValue: 10, freeClaims: 3 });
  });

  it('pipeline excludes free claims and unpaid orders from the paid counters', async () => {
    const m = model(null);
    await paidPeriodTotals(m, new Date(), new Date(), { 'sellerOrders.storeId': 's1' });
    const group = m.aggregate.mock.calls[0][0].find((s: any) => s.$group).$group;
    expect(JSON.stringify(group.paidCount)).toContain('isClaim');
    expect(JSON.stringify(group.paidCount)).toContain('paidNow');
  });
});
