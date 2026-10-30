/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { ProductsService } from './products.service';
import { BundlesService } from '../classroom/bundles.service';

const chain = (v: any) => { const c: any = { select: () => c, sort: () => c, skip: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };
const A = '507f1f77bcf86cd799439011';
const B = '507f1f77bcf86cd799439012';
const C = '507f1f77bcf86cd799439013';

function make(rows: { sold?: any[]; free?: any[]; sample?: any[]; variants?: any[] } = {}) {
  const store = new Map<string, string>();
  const productModel: any = {
    find: jest.fn((q: any) => {
      if (q.purchaseCount) return chain(rows.sold ?? []);
      if (q['digital.sampleFile.url']) return chain(rows.sample ?? []);
      return chain(rows.free ?? []);
    }),
  };
  const svc: any = Object.create(ProductsService.prototype);
  svc.databaseService = { repositories: { productModel, productVariantModel: { find: jest.fn(() => chain(rows.variants ?? [])) } } };
  svc.redisService = { get: jest.fn(async (k: string) => store.get(k) ?? null), set: jest.fn(async (k: string, v: string) => { store.set(k, v); }) };
  svc.getShapedProductsByIds = jest.fn(async (ids: string[]) => ids.map((id) => ({ _id: id, name: id })));
  return { svc, productModel, store };
}

describe('home shelves: bestsellers + free resources', () => {
  it('bestsellers query only active, non-test products that were actually bought, and keeps the order', async () => {
    const { svc, productModel } = make({ sold: [{ _id: A }, { _id: B }] });
    const res = await svc.getBestsellers(10, null);
    const q = productModel.find.mock.calls[0][0];
    expect(q.isTest).toEqual({ $ne: true });
    expect(q.isDelete).toBe(false);
    expect(q.status).toBe('active');
    expect(q.purchaseCount).toEqual({ $gte: 1 });
    expect(res.data.products.map((p: any) => p._id)).toEqual([A, B]);
  });

  it('bestsellers are cached for 10 minutes (second call does not hit the database)', async () => {
    const { svc, productModel, store } = make({ sold: [{ _id: A }] });
    await svc.getBestsellers(10, null);
    await svc.getBestsellers(10, null);
    expect(productModel.find).toHaveBeenCalledTimes(1);
    expect(store.has('home:bestsellers:v1')).toBe(true);
    expect(svc.redisService.set.mock.calls[0][2]).toBe(600);
  });

  it('bestsellers still work when Redis is down', async () => {
    const { svc } = make({ sold: [{ _id: A }] });
    svc.redisService = { get: jest.fn().mockRejectedValue(new Error('down')), set: jest.fn().mockRejectedValue(new Error('down')) };
    const res = await svc.getBestsellers(5, null);
    expect(res.data.products).toHaveLength(1);
  });

  it('free resources: price-0 digital first, then sample-offering products, never test products, no duplicates', async () => {
    const { svc, productModel } = make({
      variants: [{ productId: A }, { productId: A }],
      free: [{ _id: A }],
      sample: [{ _id: A }, { _id: C }],
    });
    const res = await svc.getFreeResources(10, null);
    for (const call of productModel.find.mock.calls) {
      expect(call[0].isTest).toEqual({ $ne: true });
      expect(call[0].productType).toEqual('digital');
    }
    expect(res.data.products.map((p: any) => [p._id, p.freeKind])).toEqual([[A, 'free'], [C, 'sample']]);
  });

  it('free resources: nothing free and no samples gives an empty list', async () => {
    const { svc } = make();
    const res = await svc.getFreeResources(10, null);
    expect(res.data.products).toEqual([]);
  });
});

describe('BundlesService.listPublic', () => {
  function makeBundles(bundles: any[], stores: string[], shape: (b: any) => any) {
    const svc: any = Object.create(BundlesService.prototype);
    svc.databaseService = {
      repositories: {
        storeModel: { find: jest.fn(() => chain(stores.map((id) => ({ _id: id })))) },
        bundleModel: { find: jest.fn(() => chain(bundles)) },
      },
    };
    svc.shape = jest.fn(async (b: any) => shape(b));
    return svc;
  }

  it('skips bundles of offline stores and bundles with a missing product, honours the limit', async () => {
    const svc = makeBundles(
      [{ _id: 'b1', storeId: 's1' }, { _id: 'b2', storeId: 'gone' }, { _id: 'b3', storeId: 's1' }, { _id: 'b4', storeId: 's1' }],
      ['s1'],
      (b) => (b._id === 'b3' ? null : { _id: b._id }),
    );
    const res = await svc.listPublic(2, null);
    expect(res.data.map((b: any) => b._id)).toEqual(['b1', 'b4']);
    expect(svc.shape).not.toHaveBeenCalledWith(expect.objectContaining({ _id: 'b2' }), null);
  });
});
