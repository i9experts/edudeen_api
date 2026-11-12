import { BadRequestException, ConflictException } from '@nestjs/common';
import { CollectionsService } from './collections.service';

jest.mock('../common/store-ownership.util', () => ({ verifyStoreOwnershipStrict: jest.fn().mockResolvedValue(undefined) }));

const ID_A = 'a'.repeat(24);
const ID_B = 'b'.repeat(24);

function build(existing: { _id: string; name: string }[], count = existing.length, ownedProducts: string[] = []) {
  const model: any = {
    find: jest.fn(() => ({ select: () => ({ lean: async () => existing }) })),
    countDocuments: jest.fn().mockResolvedValue(count),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(async (d: any) => ({ _id: 'new', ...d })),
    bulkWrite: jest.fn().mockResolvedValue({}),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  // Products of THIS store only: the query filters by _id in the request and storeId, so we answer with the owned subset.
  const productModel: any = {
    find: jest.fn((q: any) => ({ select: () => ({ lean: async () => (q._id.$in as string[]).filter((id) => ownedProducts.includes(id)).map((_id) => ({ _id })) }) })),
  };
  const db: any = { repositories: { collectionModel: model, storeModel: {}, productModel } };
  const log = { log: jest.fn().mockResolvedValue(true) };
  return { svc: new CollectionsService(db, log as any), model, log };
}

describe('CollectionsService names, limit, reorder', () => {
  it('rejects "Hurry Up !" when "hurry-up" exists (normalised compare)', async () => {
    const { svc, model } = build([{ _id: ID_A, name: 'hurry-up' }]);
    await expect(svc.create('s', 'u', { name: 'Hurry Up !', type: 'automatic' } as any)).rejects.toThrow(ConflictException);
    expect(model.create).not.toHaveBeenCalled();
  });
  it('creates a distinct name and stores normalizedName + sortOrder', async () => {
    const { svc, model, log } = build([{ _id: ID_A, name: 'Offer' }]);
    await svc.create('s', 'u', { name: 'New Arrivals', type: 'automatic' } as any);
    expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ normalizedName: 'newarrivals', sortOrder: 1 }));
    expect(log.log).toHaveBeenCalled();
  });
  it('blocks the 21st collection', async () => {
    const { svc } = build([], 20);
    await expect(svc.create('s', 'u', { name: 'Extra', type: 'automatic' } as any)).rejects.toThrow(BadRequestException);
  });
  it('create refuses a manual collection holding another seller\'s product', async () => {
    const { svc, model } = build([], 0, [ID_A]);
    await expect(svc.create('s', 'u', { name: 'Mine', type: 'manual', productIds: [ID_A, ID_B] } as any)).rejects.toThrow(BadRequestException);
    expect(model.create).not.toHaveBeenCalled();
  });
  it('create accepts a manual collection of the store\'s own products', async () => {
    const { svc, model } = build([], 0, [ID_A, ID_B]);
    await svc.create('s', 'u', { name: 'Mine', type: 'manual', productIds: [ID_A, ID_B] } as any);
    expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ productIds: [ID_A, ID_B], status: 'active' }));
  });
  it('updateProducts refuses a foreign product id and writes nothing', async () => {
    const { svc, model } = build([], 0, [ID_A]);
    model.findOne.mockResolvedValue({ _id: 'c1', type: 'manual', name: 'x' });
    await expect(svc.updateProducts('s', 'u', 'c1', { productIds: [ID_A, ID_B] } as any)).rejects.toThrow(BadRequestException);
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });
  it('reorder refuses ids that are not this store\'s', async () => {
    const { svc, model } = build([{ _id: ID_A, name: 'x' }]);
    await expect(svc.reorder('s', 'u', { ids: [ID_A, ID_B] })).rejects.toThrow(BadRequestException);
    expect(model.bulkWrite).not.toHaveBeenCalled();
  });
  it('reorder writes sortOrder in the given order', async () => {
    const { svc, model } = build([{ _id: ID_A, name: 'x' }, { _id: ID_B, name: 'y' }]);
    await svc.reorder('s', 'u', { ids: [ID_B, ID_A] });
    const ops = model.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.filter._id).toBe(ID_B);
    expect(ops[0].updateOne.update.$set.sortOrder).toBe(0);
    expect(ops[1].updateOne.update.$set.sortOrder).toBe(1);
  });
});
