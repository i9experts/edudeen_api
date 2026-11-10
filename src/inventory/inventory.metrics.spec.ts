import { InventoryService } from './inventory.service';

const P1 = 'a'.repeat(24);
const P2 = 'b'.repeat(24);

function build(pro: boolean, tracked = true) {
  const prods = [
    { _id: P1, name: 'Grade 5 Complete Maths Workbook - Noor', type: 'digital', images: ['i'], description: 'short', tags: [], status: 'active' },
    { _id: P2, name: 'Grade 5 Complete Science Workbook - Noor', type: 'digital', images: ['1', '2', '3'], description: 'x'.repeat(300), categoryId: 'c', subCategoryId: 's', classFrom: 'class-5', classTo: 'class-5', tags: ['a', 'b', 'c'], digital: { sampleFile: { url: 'u' } }, coverStyle: 'book', status: 'active' },
  ];
  const chain = (rows: any[]) => {
    const c: any = { sort: () => c, skip: () => c, limit: () => c, select: () => c, lean: async () => rows };
    return c;
  };
  const productModel: any = {
    find: jest.fn((f: any) => chain(f?._id?.$in ? prods.filter((p) => f._id.$in.includes(p._id)) : prods)),
    distinct: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn().mockResolvedValue(2),
    aggregate: jest.fn().mockResolvedValue([]),
  };
  const orderModel: any = {
    aggregate: jest.fn().mockResolvedValue([
      // the shape productSalesRows reads after its last $group
      { _id: P2, orders: 3, trackedOrders: 3, revenue: 300, freeClaims: 0 },
    ]),
  };
  const repos: any = {
    productModel,
    orderModel,
    productVariantModel: { find: jest.fn().mockReturnValue(chain([])), distinct: jest.fn() },
    storeModel: { exists: jest.fn().mockResolvedValue({ _id: 1 }) },
    categoryModel: {},
    courseModel: { find: jest.fn().mockReturnValue(chain([])) },
  };
  const visitModel: any = {
    findOne: jest.fn().mockReturnValue({ sort: () => ({ select: () => ({ lean: async () => (tracked ? { pktDate: '2020-01-01' } : null) }) }) }),
    aggregate: jest.fn().mockResolvedValue([{ _id: P2, visits: 40 }]),
  };
  const ent: any = { getLimits: jest.fn().mockResolvedValue({ advancedAnalyticsAllowed: pro }) };
  return { svc: new InventoryService({ repositories: repos } as any, visitModel, ent), visitModel, orderModel, productModel };
}

describe('getStoreInventory 30-day metrics + quality', () => {
  it('rows carry views30d / sales30d / quality; Pro sees conversion', async () => {
    const { svc, visitModel } = build(true);
    const res: any = await svc.getStoreInventory('s1', 'st1', {});
    const [r1, r2] = res.data.products;
    expect(r2.views30d).toBe(40);
    expect(r2.sales30d).toBe(3);
    expect(r2.conversionPct).toBe(7.5);
    expect(r1.views30d).toBe(0);
    expect(r1.sales30d).toBe(0);
    expect(r1.qualityScore).toBeLessThan(r2.qualityScore);
    expect(r1.qualityMissing.length).toBeGreaterThan(0);
    // views aggregate limited to THIS page's product ids
    expect(visitModel.aggregate.mock.calls[0][0][0].$match.productId).toEqual({ $in: [P1, P2] });
  });

  it('free plan: no conversion, flagged as locked', async () => {
    const { svc } = build(false);
    const res: any = await svc.getStoreInventory('s1', 'st1', {});
    expect(res.data.products[1].conversionPct).toBeNull();
    expect(res.data.products[1].conversionLocked).toBe(true);
    expect(res.data.products[1].views30d).toBe(40);
  });

  it('no tracked visit day yet -> views null (shown as a dash), sales still counted', async () => {
    const { svc } = build(true, false);
    const res: any = await svc.getStoreInventory('s1', 'st1', {});
    expect(res.data.products[1].views30d).toBeNull();
    expect(res.data.products[1].conversionPct).toBeNull();
    expect(res.data.products[1].sales30d).toBe(3);
  });

  it('sort=views puts the most viewed product first', async () => {
    const { svc } = build(true);
    const res: any = await svc.getStoreInventory('s1', 'st1', { sort: 'views' });
    expect(res.data.products.map((p: any) => String(p.productId))).toEqual([P2, P1]);
  });

  it('quality=low keeps only products under 60', async () => {
    const { svc, productModel } = build(true);
    await svc.getStoreInventory('s1', 'st1', { quality: 'low' });
    const filter = productModel.countDocuments.mock.calls[0][0];
    expect(filter._id.$in.map(String)).toEqual([P1]);
  });
});
