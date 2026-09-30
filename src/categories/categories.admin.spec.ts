/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';

const ID = '64f0c0ffee0c0ffee0c0ff01';
const OTHER = '64f0c0ffee0c0ffee0c0ff02';
const META = { adminId: 'admin-1', ip: '1.1.1.1', userAgent: 'jest' };

describe('CategoriesService — admin management', () => {
  let categoryModel: any, productModel: any, storeModel: any, activity: any, service: CategoriesService;
  const cat = (o: any = {}) => ({ _id: ID, name: 'Math', parentId: null, isDelete: false, status: 'active', ...o });

  beforeEach(() => {
    categoryModel = {
      findOne: jest.fn(), findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: ID }),
      countDocuments: jest.fn().mockResolvedValue(0), updateOne: jest.fn().mockResolvedValue({}), bulkWrite: jest.fn().mockResolvedValue({}),
    };
    productModel = { countDocuments: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 3 }) };
    storeModel = { countDocuments: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    activity = { log: jest.fn() };
    const db: any = { repositories: { categoryModel, productModel, storeModel } };
    service = new CategoriesService(db, activity);
  });

  describe('updateCategory', () => {
    it('rejects an invalid id with 400 and a missing category with 404', async () => {
      await expect(service.updateCategory('nope', { name: 'x' }, META)).rejects.toThrow(BadRequestException);
      categoryModel.findOne.mockResolvedValue(null);
      await expect(service.updateCategory(ID, { name: 'x' }, META)).rejects.toThrow(NotFoundException);
    });

    it('rejects a rename that collides with a sibling', async () => {
      categoryModel.findOne.mockResolvedValueOnce(cat()).mockResolvedValueOnce(cat({ _id: OTHER, name: 'Science' }));
      await expect(service.updateCategory(ID, { name: 'Science' }, META)).rejects.toThrow(ConflictException);
    });

    it('only sets whitelisted fields (never slug/parentId) and writes an audit entry', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      await service.updateCategory(ID, { sortOrder: 4, isActive: false, slug: 'hacked', parentId: 'x' } as any, META);
      expect(categoryModel.findByIdAndUpdate).toHaveBeenCalledWith(ID, { $set: { sortOrder: 4, status: 'inactive' } }, { returnDocument: 'after' });
      expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'category_updated', actorId: 'admin-1', actorRole: 'admin', targetId: ID }));
    });
  });

  describe('reorderCategories', () => {
    it('bulk-updates sortOrder and audits; refuses unknown or duplicate ids', async () => {
      categoryModel.countDocuments.mockResolvedValue(2);
      await service.reorderCategories({ items: [{ id: ID, sortOrder: 1 }, { id: OTHER, sortOrder: 0 }] }, META);
      expect(categoryModel.bulkWrite).toHaveBeenCalledTimes(1);
      expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'category_reordered' }));
      await expect(service.reorderCategories({ items: [{ id: ID, sortOrder: 1 }, { id: ID, sortOrder: 2 }] }, META)).rejects.toThrow(/Duplicate/);
      categoryModel.countDocuments.mockResolvedValue(1);
      await expect(service.reorderCategories({ items: [{ id: ID, sortOrder: 1 }, { id: OTHER, sortOrder: 2 }] }, META)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteCategory', () => {
    it('soft-deletes an unreferenced category and audits it', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      await service.deleteCategory(ID, undefined, META);
      expect(categoryModel.updateOne).toHaveBeenCalledWith({ _id: ID }, { $set: { isDelete: true, status: 'inactive' } });
      expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'category_deleted' }));
    });

    it('refuses while subcategories exist', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      categoryModel.countDocuments.mockResolvedValue(2);
      await expect(service.deleteCategory(ID, undefined, META)).rejects.toThrow(/subcategor/);
      expect(categoryModel.updateOne).not.toHaveBeenCalled();
    });

    it('refuses while products still reference it and nothing is deleted', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      productModel.countDocuments.mockResolvedValue(5);
      await expect(service.deleteCategory(ID, undefined, META)).rejects.toThrow(ConflictException);
      expect(categoryModel.updateOne).not.toHaveBeenCalled();
      expect(productModel.updateMany).not.toHaveBeenCalled();
    });

    it('reassigns products and stores of a main category to another main category, then deletes', async () => {
      categoryModel.findOne.mockResolvedValueOnce(cat()).mockResolvedValueOnce(cat({ _id: OTHER, name: 'Science' }));
      productModel.countDocuments.mockResolvedValue(3);
      storeModel.countDocuments.mockResolvedValue(1);
      const res: any = await service.deleteCategory(ID, OTHER, META);
      expect(productModel.updateMany).toHaveBeenCalledWith({ categoryId: ID, isDelete: false }, { $set: { categoryId: OTHER } });
      expect(storeModel.updateMany).toHaveBeenCalledWith({ categoryId: ID, isDelete: false }, { $set: { categoryId: OTHER } });
      expect(res.data.reassigned).toEqual({ products: 3, stores: 1 });
      expect(categoryModel.updateOne).toHaveBeenCalled();
    });

    it('will not move a subcategory under a different main category, or reassign across levels', async () => {
      categoryModel.findOne
        .mockResolvedValueOnce(cat({ parentId: 'rootA' }))
        .mockResolvedValueOnce(cat({ _id: OTHER, parentId: 'rootB' }));
      productModel.countDocuments.mockResolvedValue(2);
      await expect(service.deleteCategory(ID, OTHER, META)).rejects.toThrow(/same main category/);
      expect(productModel.updateMany).not.toHaveBeenCalled();
      expect(categoryModel.updateOne).not.toHaveBeenCalled();
    });

    it('rejects reassigning onto itself or a bad id', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      productModel.countDocuments.mockResolvedValue(1);
      await expect(service.deleteCategory(ID, ID, META)).rejects.toThrow(BadRequestException);
      await expect(service.deleteCategory(ID, 'bad', META)).rejects.toThrow(BadRequestException);
    });
  });
});
