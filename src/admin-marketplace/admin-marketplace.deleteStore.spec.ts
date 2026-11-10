/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { NotFoundException } from '@nestjs/common';
import { AdminMarketplaceService } from './admin-marketplace.service';

const STORE = { _id: 'store-1', name: 'Uzair Book Center', sellerId: 'seller-1', isDelete: false };

function build(products: { _id: string }[] = [{ _id: 'p1' }, { _id: 'p2' }]) {
  const storeModel: any = {
    findOne: jest.fn().mockResolvedValue({ ...STORE }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  const productModel: any = {
    find: jest.fn(() => ({ lean: () => Promise.resolve(products) })),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: products.length }),
  };
  const cartModel: any = { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) };
  const wishListModel: any = { deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }) };
  const activityLogService: any = { log: jest.fn().mockResolvedValue(true) };
  const notificationsService: any = { notify: jest.fn().mockResolvedValue(true) };

  const databaseService: any = { repositories: { storeModel, productModel, cartModel, wishListModel } };
  const svc = new AdminMarketplaceService(databaseService, activityLogService, notificationsService, {} as any, {} as any, {} as any);
  return { svc, storeModel, productModel, cartModel, wishListModel, activityLogService, notificationsService };
}

describe('AdminMarketplaceService.deleteStore', () => {
  it('rejects an unknown or already-deleted store', async () => {
    const { svc, storeModel } = build();
    storeModel.findOne.mockResolvedValueOnce(null);
    await expect(svc.deleteStore('store-1', 'A legitimate reason with enough length', { adminId: 'admin-1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('soft-deletes the store, every one of its products, and cleans up carts/wishlists', async () => {
    const { svc, storeModel, productModel, cartModel, wishListModel, activityLogService, notificationsService } = build();
    const res = await svc.deleteStore('store-1', 'Repeated counterfeit listings after two prior warnings', { adminId: 'admin-1' });

    expect(storeModel.updateOne).toHaveBeenCalledWith(
      { _id: 'store-1' },
      { $set: expect.objectContaining({ isDelete: true, status: 'suspended' }) },
    );
    expect(productModel.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['p1', 'p2'] } },
      { $set: expect.objectContaining({ isDelete: true, status: 'inactive', isFeatured: false, removedByAdmin: true }) },
    );
    expect(cartModel.updateMany).toHaveBeenCalledWith(
      { 'items.productId': { $in: ['p1', 'p2'] } },
      { $pull: { items: { productId: { $in: ['p1', 'p2'] } } } },
    );
    expect(wishListModel.deleteMany).toHaveBeenCalledWith({ productId: { $in: ['p1', 'p2'] } });
    expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'store_deleted', targetId: 'store-1', targetType: 'store' }));
    expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'seller-1', type: 'store_deleted' }));
    expect(res.data).toEqual({ deletedProducts: 2 });
  });

  it('does not touch carts/wishlists when the store has no active products', async () => {
    const { svc, productModel, cartModel, wishListModel } = build([]);
    const res = await svc.deleteStore('store-1', 'This store has had zero sales activity for a year', { adminId: 'admin-1' });
    expect(productModel.updateMany).not.toHaveBeenCalled();
    expect(cartModel.updateMany).not.toHaveBeenCalled();
    expect(wishListModel.deleteMany).not.toHaveBeenCalled();
    expect(res.data).toEqual({ deletedProducts: 0 });
  });
});
