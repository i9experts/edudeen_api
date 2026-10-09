import { periodTotals } from './order-aggregation.util';

// Regression: platform/admin totals summed PKR and USD orders together and labelled the result "$".
// With a converter every currency bucket must be converted before it is added.
describe('periodTotals currency handling', () => {
  const rows = [
    { _id: 'PKR', orderCount: 2, cancelledCount: 0, refundedCount: 0, grossRevenue: 5600, refundAmount: 0, buyerIds: ['a', 'b'] },
    { _id: 'USD', orderCount: 1, cancelledCount: 0, refundedCount: 0, grossRevenue: 10, refundAmount: 0, buyerIds: ['b'] },
  ];
  const model = { aggregate: jest.fn().mockResolvedValue(rows) } as any;
  const toUSD = async (amount: number, from: string) => (from === 'PKR' ? amount / 280 : amount);

  it('converts each currency before summing', async () => {
    const totals = await periodTotals(model, new Date(0), new Date(), undefined, toUSD);
    expect(totals.grossRevenue).toBe(30); // 5600 PKR = $20, plus $10
    expect(totals.orderCount).toBe(3);
    expect(totals.uniqueBuyerCount).toBe(2);
    expect(totals.unconvertedCurrencies).toEqual([]);
  });

  it('leaves a currency it cannot convert out of the money totals and reports it', async () => {
    const failing = async (amount: number, from: string) => { if (from === 'PKR') throw new Error('no rate'); return amount; };
    const totals = await periodTotals(model, new Date(0), new Date(), undefined, failing);
    expect(totals.grossRevenue).toBe(10);
    expect(totals.unconvertedCurrencies).toEqual(['PKR']);
  });
});
