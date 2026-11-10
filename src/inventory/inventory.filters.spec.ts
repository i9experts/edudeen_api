import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InventoryService } from './inventory.service';

const CAT = 'a'.repeat(24);

function build(storeExists = true) {
  const find = jest.fn();
  const chain = (rows: any[]) => ({ sort: () => ({ select: () => ({ lean: async () => rows }), skip: () => ({ limit: () => ({ lean: async () => rows }) }) }), select: () => ({ lean: async () => rows }) });
  find.mockImplementation(() => chain([]));
  const productModel: any = {
    find,
    distinct: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue([{ _id: 'active', n: 3 }, { _id: 'rejected', n: 1 }]),
  };
  const categoryModel: any = { find: jest.fn().mockReturnValue({ lean: async () => [{ _id: CAT, parentId: null }] }) };
  const repos: any = {
    productModel,
    productVariantModel: { find: jest.fn().mockReturnValue(chain([])), distinct: jest.fn().mockResolvedValue([]) },
    storeModel: { exists: jest.fn().mockResolvedValue(storeExists ? { _id: 1 } : null) },
    categoryModel,
  };
  const svc = new InventoryService({ repositories: repos } as any);
  return { svc, productModel };
}

describe('getStoreInventory filters', () => {
  it('status list, type and format combine; counts come from one $group', async () => {
    const { svc, productModel } = build();
    const res: any = await svc.getStoreInventory('s1', 'st1', { status: 'active,scheduled', type: 'digital', deliveryFormat: 'course' });
    const filter = productModel.countDocuments.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ['active', 'scheduled'] });
    expect(filter.type).toBe('digital');
    expect(filter.$and).toEqual([{ deliveryFormat: 'course' }]);
    expect(productModel.aggregate).toHaveBeenCalledTimes(1);
    expect(res.data.stats.statusCounts).toEqual({ active: 3, rejected: 1 });
  });

  it('rejects a bad categoryId and a bad deliveryFormat with 400', async () => {
    const { svc } = build();
    await expect(svc.getStoreInventory('s1', 'st1', { categoryId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getStoreInventory('s1', 'st1', { deliveryFormat: 'live_class' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('another seller gets 403', async () => {
    const { svc } = build(false);
    await expect(svc.getStoreInventory('other', 'st1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stockState / sortBy / order: bad value = 400, valid ones are accepted', async () => {
    const { svc } = build();
    await expect(svc.getStoreInventory('s1', 'st1', { stockState: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getStoreInventory('s1', 'st1', { sortBy: 'colour' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getStoreInventory('s1', 'st1', { order: 'up' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getStoreInventory('s1', 'st1', { stockState: 'low', sortBy: 'stock', order: 'desc' })).resolves.toBeTruthy();
  });

  it('stock buckets match scanStock and sort works across pages', async () => {
    const mk = (id: string, name: string, type = 'physical') => ({ _id: id, name, type, status: 'active' });
    const prods = [mk('a', 'A'), mk('b', 'B'), mk('c', 'C'), mk('d', 'D', 'digital'), mk('e', 'E')];
    const variants = [
      { productId: 'a', stock: 0 }, { productId: 'b', stock: 4 }, { productId: 'c', stock: 50 },
      { productId: 'd', stock: 0 }, { productId: 'e', stock: 10 },
    ];
    const { svc, productModel } = build();
    const lean = (rows: any[]) => ({ sort: () => ({ select: () => ({ lean: async () => rows }), skip: () => ({ limit: () => ({ lean: async () => [] }) }) }), select: () => ({ lean: async () => rows }), lean: async () => rows });
    productModel.find.mockImplementation(() => lean(prods));
    (svc as any).databaseService.repositories.productVariantModel.find = jest.fn(() => lean(variants));
    const low: any = await svc.getStoreInventory('s1', 'st1', { stockState: 'low' });
    const filter = productModel.countDocuments.mock.calls.at(-1)[0];
    expect(filter._id.$in.sort()).toEqual(['b', 'e']); // 4 and 10 (<=10), not 0 / 50 / digital
    expect(low.data.stats).toBeDefined();
    const asc: any = await svc.getStoreInventory('s1', 'st1', { sortBy: 'stock', order: 'asc', limit: 2, page: 1 });
    expect(asc.success).toBe(true);
    expect(productModel.countDocuments.mock.calls.at(-1)[0]._id.$in).toHaveLength(5);
  });

  it('category filter covers the category and its descendants', async () => {
    const { svc, productModel } = build();
    await svc.getStoreInventory('s1', 'st1', { categoryId: CAT });
    const filter = productModel.countDocuments.mock.calls[0][0];
    expect(filter.$and[0].$or[0].categoryId.$in).toContain(CAT);
  });
});
