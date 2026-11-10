import { BundlesService } from './bundles.service';
import { bundleQuote, bundleSavings, cleanBundleInput } from './bundle.util';

jest.mock('../common/store-ownership.util', () => ({ verifyStoreOwnershipStrict: jest.fn().mockResolvedValue(undefined) }));

const A = 'a'.repeat(24); const B = 'b'.repeat(24); const C = 'c'.repeat(24); const D = 'd'.repeat(24);

function build(opts: { together?: any[]; sameSubject?: any[]; products?: any[]; variants?: any[] }) {
  const productFind: any[] = [];
  const productModel: any = {
    find: jest.fn((filter: any) => {
      productFind.push(filter);
      const chain: any = { select: () => chain, sort: () => chain, limit: () => chain };
      chain.then = undefined;
      chain.lean = async () => {
        if (filter.subCategoryId) return opts.sameSubject ?? [];
        if (filter._id?.$nin) return opts.together ?? [];
        return opts.products ?? [{ _id: A, subCategoryId: 'sub1' }];
      };
      return chain;
    }),
  };
  const orderModel: any = { aggregate: jest.fn(async () => opts.together ? opts.together.map((t, i) => ({ _id: String(t._id), n: 10 - i })) : []) };
  const productVariantModel: any = { find: jest.fn(() => ({ select: () => ({ lean: async () => opts.variants ?? [] }) })) };
  const db: any = { repositories: { productModel, orderModel, productVariantModel, storeModel: {}, bundleModel: {} } };
  return { svc: new BundlesService(db, {} as any), orderModel, productFind };
}

describe('bundle suggestions', () => {
  it('queries ONLY this store (orders + products) and never returns picked items', async () => {
    const { svc, orderModel, productFind } = build({ together: [{ _id: B, name: 'B' }], sameSubject: [{ _id: C, name: 'C' }] });
    const res: any = await svc.suggestions('store1', 'seller', [A]);
    expect(orderModel.aggregate.mock.calls[0][0][0]).toEqual({ $match: { 'sellerOrders.storeId': 'store1' } });
    const scoped = productFind.filter((f) => f.subCategoryId || f._id?.$nin);
    expect(scoped.length).toBe(2);
    for (const f of scoped) { expect(f.storeId).toBe('store1'); expect(f._id.$nin).toEqual([A]); }
    expect(res.data.map((x: any) => x._id).sort()).toEqual([B, C].sort());
    expect(res.data.length).toBeLessThanOrEqual(6);
    expect(res.data.find((x: any) => x._id === A)).toBeUndefined();
  });
  it('empty selection = no suggestions, no queries', async () => {
    const { svc, orderModel } = build({});
    expect((await svc.suggestions('store1', 'seller', []) as any).data).toEqual([]);
    expect(orderModel.aggregate).not.toHaveBeenCalled();
  });
});

describe('bundle quote = cart arithmetic', () => {
  it('modal/card quote equals the cart discount when every item is added once', () => {
    const prices = [1000, 450, 275.5];
    const pct = 20;
    const q = bundleQuote(prices, pct);
    const lines = prices.map((p, i) => ({ productId: String(i), quantity: 1, totalPrice: p }));
    const cartSavings = bundleSavings({ productIds: ['0', '1', '2'], discountPercent: pct }, lines);
    expect(q.savings).toBe(cartSavings);
    expect(q.bundlePrice).toBe(Math.round((q.totalPrice - cartSavings) * 100) / 100);
  });
  it('cover image must be https; Urdu name optional', () => {
    expect(() => cleanBundleInput({ name: 'x', productIds: [A, B], discountPercent: 10, coverImage: 'http://a.b/c.png' })).toThrow();
    const ok = cleanBundleInput({ name: 'x', productIds: [A, B], discountPercent: 10, coverImage: 'https://res.cloudinary.com/x.png', nameUr: ' نام ' });
    expect(ok.coverImage).toBe('https://res.cloudinary.com/x.png');
    expect(ok.nameUr).toBe('نام');
    expect(cleanBundleInput({ name: 'x', productIds: [A, B, C, D], discountPercent: 10 }).coverImage).toBeUndefined();
  });
});
