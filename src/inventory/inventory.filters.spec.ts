import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InventoryService } from './inventory.service';

const CAT = 'a'.repeat(24);

function build(storeExists = true) {
  const find = jest.fn();
  const chain = (rows: any[]) => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }), select: () => ({ lean: async () => rows }) });
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

  it('category filter covers the category and its descendants', async () => {
    const { svc, productModel } = build();
    await svc.getStoreInventory('s1', 'st1', { categoryId: CAT });
    const filter = productModel.countDocuments.mock.calls[0][0];
    expect(filter.$and[0].$or[0].categoryId.$in).toContain(CAT);
  });
});
