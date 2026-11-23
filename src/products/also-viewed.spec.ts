/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

const chain = (v: any) => { const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };
const P = '507f1f77bcf86cd799439011';
const A = '507f1f77bcf86cd799439012';
const B = '507f1f77bcf86cd799439013';

function make(opts: { product?: any; viewers?: any[]; rows?: any[] } = {}) {
  const store = new Map<string, string>();
  const productModel: any = { findOne: jest.fn(() => chain('product' in opts ? opts.product : { _id: P })) };
  const recentlyViewedModel: any = {
    find: jest.fn(() => chain(opts.viewers ?? [])),
    aggregate: jest.fn(async () => opts.rows ?? []),
  };
  const svc: any = Object.create(ProductsService.prototype);
  svc.databaseService = { repositories: { productModel, recentlyViewedModel } };
  svc.redisService = { get: jest.fn(async (k: string) => store.get(k) ?? null), set: jest.fn(async (k: string, v: string) => { store.set(k, v); }) };
  svc.getShapedProductsByIds = jest.fn(async (ids: string[]) => ids.map((id) => ({ _id: id, variants: [{ isDefault: true, price: 10 }] })));
  return { svc, recentlyViewedModel, store };
}
const viewers = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}` }));

describe('getAlsoViewed', () => {
  it('404 when the product is not active', async () => {
    const { svc } = make({ product: null });
    await expect(svc.getAlsoViewed(P, 12, null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('empty with fewer than 3 viewers (no aggregation run)', async () => {
    const { svc, recentlyViewedModel } = make({ viewers: viewers(2), rows: [{ _id: A, n: 2 }] });
    const res = await svc.getAlsoViewed(P, 12, null);
    expect(res.data.products).toEqual([]);
    expect(recentlyViewedModel.aggregate).not.toHaveBeenCalled();
  });

  it('returns co-viewed products in order, excludes the current product, needs >= 2 co-viewers, never exposes user ids', async () => {
    const { svc, recentlyViewedModel } = make({ viewers: viewers(5), rows: [{ _id: A, n: 4 }, { _id: 'not-an-id', n: 3 }, { _id: B, n: 2 }] });
    const res = await svc.getAlsoViewed(P, 12, null);
    const pipeline = recentlyViewedModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.productId).toEqual({ $ne: P });
    expect(pipeline.some((s: any) => s.$match?.n?.$gte === 2)).toBe(true);
    expect(res.data.products.map((p: any) => p._id)).toEqual([A, B]);
    expect(JSON.stringify(res)).not.toContain('u0');
  });

  it('drops items the shaping gate removes or that are priced Rs 0 with a strike price', async () => {
    const { svc } = make({ viewers: viewers(4), rows: [{ _id: A, n: 3 }, { _id: B, n: 3 }] });
    svc.getShapedProductsByIds = jest.fn(async () => [{ _id: A, variants: [{ isDefault: true, price: 0, compareAtPrice: 500 }] }, { _id: B, variants: [{ isDefault: true, price: 20 }] }]);
    const res = await svc.getAlsoViewed(P, 12, null);
    expect(res.data.products.map((p: any) => p._id)).toEqual([B]);
  });

  it('caches candidate ids for 10 minutes (second call skips the database)', async () => {
    const { svc, recentlyViewedModel, store } = make({ viewers: viewers(4), rows: [{ _id: A, n: 3 }] });
    await svc.getAlsoViewed(P, 12, null);
    await svc.getAlsoViewed(P, 12, null);
    expect(recentlyViewedModel.find).toHaveBeenCalledTimes(1);
    expect(store.has(`product:also-viewed:v1:${P}`)).toBe(true);
    expect(svc.redisService.set.mock.calls[0][2]).toBe(600);
  });
});
