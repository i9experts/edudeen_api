/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { ProductsService } from './products.service';

const chain = (v: any) => { const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };

function make(isPremium: boolean) {
  const stores = [
    { _id: 's1', premiumDiscount: { enabled: true, percent: 10 } },
    { _id: 's2', premiumDiscount: { enabled: true, percent: 20 } },
  ];
  const products = [
    { _id: 'p1', storeId: 's1' },
    { _id: 'p2', storeId: 's2' },
    { _id: 'p3', storeId: 's1', premiumOptOut: true },
  ];
  const svc: any = Object.create(ProductsService.prototype);
  svc.databaseService = { repositories: { storeModel: { find: jest.fn(() => chain(stores)) }, productModel: { find: jest.fn(() => chain(products)) } } };
  svc.premiumService = { getEntitlements: jest.fn().mockResolvedValue({ isPremium }) };
  svc.premiumDealsPool = null;
  // Shaped output: the member price per product (what decorateProducts would produce).
  svc.attachVariantsAndPricing = jest.fn(async (docs: any[]) => docs.map((p) => {
    const pct = p._id === 'p2' ? 23 : 13;
    return { ...p, variants: [{ isDefault: true, price: 100, premiumPrice: 100 - pct, premiumDiscountPercent: pct }] };
  }));
  return svc;
}

describe('ProductsService.getPremiumDeals', () => {
  it('non-members and guests get an empty list and no DB work', async () => {
    const svc = make(false);
    expect((await svc.getPremiumDeals(12, 'u1')).data).toEqual({ isPremium: false, products: [] });
    expect((await svc.getPremiumDeals(12, null)).data.products).toEqual([]);
    expect(svc.attachVariantsAndPricing).not.toHaveBeenCalled();
  });
  it('members: highest Premium percent first, opted-out products excluded, limit honoured', async () => {
    const svc = make(true);
    const r = await svc.getPremiumDeals(12, 'u1');
    expect(r.data.isPremium).toBe(true);
    expect(r.data.products.map((p: any) => p._id)).toEqual(['p2', 'p1']);
    const one = await svc.getPremiumDeals(1, 'u1');
    expect(one.data.products.map((p: any) => p._id)).toEqual(['p2']);
  });
});