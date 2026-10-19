/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { invalidateCategoryTreeCache } from './category-tree.util';

const ID = '64f0c0ffee0c0ffee0c0ff01';
const OTHER = '64f0c0ffee0c0ffee0c0ff02';
const META = { adminId: 'admin-1', ip: '1.1.1.1', userAgent: 'jest' };

describe('CategoriesService — admin management', () => {
  let categoryModel: any, productModel: any, storeModel: any, activity: any, service: CategoriesService;
  let rows: any[] = [];
  const cat = (o: any = {}) => ({ _id: ID, name: 'Math', parentId: null, isDelete: false, status: 'active', ...o });

  beforeEach(() => {
    rows = [];
    invalidateCategoryTreeCache();
    categoryModel = {
      find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(rows) })),
      updateMany: jest.fn().mockResolvedValue({}),
      findOne: jest.fn(), findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: ID }),
      countDocuments: jest.fn().mockResolvedValue(0), updateOne: jest.fn().mockResolvedValue({}), bulkWrite: jest.fn().mockResolvedValue({}),
    };
    productModel = { countDocuments: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 3 }) };
    storeModel = { countDocuments: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }), find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) };
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

  describe('getAdminCategoryTree', () => {
    it('nests every non-deleted category (inactive included) in sortOrder and drops orphans', async () => {
      const rows = [
        { _id: 'r1', name: 'B', parentId: null, status: 'active', sortOrder: 0 },
        { _id: 'r2', name: 'A', parentId: null, status: 'inactive', sortOrder: 1 },
        { _id: 's1', name: 'Sub', parentId: 'r1', status: 'inactive', sortOrder: 0 },
        { _id: 'o1', name: 'Orphan', parentId: 'gone', status: 'active', sortOrder: 0 },
      ];
      const sort = jest.fn(() => ({ lean: jest.fn().mockResolvedValue(rows) }));
      categoryModel.find = jest.fn(() => ({ sort }));
      productModel.aggregate = jest.fn().mockResolvedValue([{ _id: 'r1', count: 2 }]);
      const res: any = await service.getAdminCategoryTree();
      expect(categoryModel.find).toHaveBeenCalledWith({ isDelete: false });
      expect(sort).toHaveBeenCalledWith({ sortOrder: 1, _id: 1 });
      expect(res.data.map((n: any) => n._id)).toEqual(['r1', 'r2']);
      expect(res.data[0].children.map((n: any) => n._id)).toEqual(['s1']);
      expect(res.data[0].productCount).toBe(2);
    });
  });

  describe('deleteCategory', () => {
    it('soft-deletes an unreferenced category and audits it', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      await service.deleteCategory(ID, undefined, META);
      expect(categoryModel.updateOne).toHaveBeenCalledWith({ _id: ID }, { $set: { isDelete: true, status: 'inactive' } });
      expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'category_deleted' }));
    });

    it('refuses while subcategories exist (any depth) and deletes nothing', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      rows = [{ _id: ID, parentId: null }, { _id: OTHER, parentId: ID }, { _id: 'deep', parentId: OTHER }];
      await expect(service.deleteCategory(ID, undefined, META)).rejects.toThrow(/2 subcategories/);
      expect(categoryModel.updateOne).not.toHaveBeenCalled();
      expect(categoryModel.updateMany).not.toHaveBeenCalled();
    });

    it('deleteChildren soft-deletes the whole subtree in one write', async () => {
      categoryModel.findOne.mockResolvedValue(cat());
      rows = [{ _id: ID, parentId: null }, { _id: OTHER, parentId: ID }, { _id: 'deep', parentId: OTHER }];
      const res: any = await service.deleteCategory(ID, undefined, META, true);
      expect(categoryModel.updateMany).toHaveBeenCalledWith({ _id: { $in: [ID, OTHER, 'deep'] } }, { $set: { isDelete: true, status: 'inactive' } });
      expect(res.data.deletedChildren).toBe(2);
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
      expect(productModel.updateMany).toHaveBeenCalledWith({ categoryId: ID, isDelete: false }, { $set: { categoryId: OTHER, subCategoryId: null } });
      expect(storeModel.updateMany).toHaveBeenCalledWith({ categoryId: ID, isDelete: false }, { $set: { categoryId: OTHER } });
      expect(res.data.reassigned).toEqual({ products: 3, stores: 1 });
      expect(categoryModel.updateOne).toHaveBeenCalled();
    });

    it('a deep subtree moves its products (subCategoryId in subtree) to a node of the same main category', async () => {
      // root R > ID (to delete) > child ; sibling OTHER under R
      rows = [{ _id: 'R', parentId: null }, { _id: ID, parentId: 'R' }, { _id: 'child', parentId: ID }, { _id: OTHER, parentId: 'R' }];
      categoryModel.findOne
        .mockResolvedValueOnce(cat({ parentId: 'R' }))
        .mockResolvedValueOnce(cat({ _id: OTHER, parentId: 'R' }));
      productModel.countDocuments.mockResolvedValue(4);
      await service.deleteCategory(ID, OTHER, META, true);
      expect(productModel.updateMany).toHaveBeenCalledWith(
        { subCategoryId: { $in: [ID, 'child'] }, isDelete: false }, { $set: { subCategoryId: OTHER } },
      );
    });

    it('will not move products to a different main category, into the deleted subtree, or across levels', async () => {
      rows = [{ _id: 'rootA', parentId: null }, { _id: ID, parentId: 'rootA' }, { _id: 'rootB', parentId: null }, { _id: OTHER, parentId: 'rootB' }];
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

  describe('addCategory depth limit', () => {
    const adminDb = () => {
      (service as any).databaseService.repositories.adminModel = { findOne: jest.fn().mockResolvedValue({ _id: 'admin-1' }) };
      categoryModel.create = jest.fn(async (d: any) => d);
    };
    // chain: L1 <- L2 <- L3 <- L4
    const chain: Record<string, any> = {
      L1: { _id: 'L1', name: 'L1', parentId: null },
      L2: { _id: 'L2', name: 'L2', parentId: 'L1' },
      L3: { _id: 'L3', name: 'L3', parentId: 'L2' },
      L4: { _id: 'L4', name: 'L4', parentId: 'L3' },
    };
    beforeEach(() => {
      adminDb();
      categoryModel.findOne.mockImplementation(async (q: any) => (q._id ? chain[q._id] ?? null : null));
    });

    it('allows nesting under levels 1, 2 and 3', async () => {
      for (const p of ['L1', 'L2', 'L3']) {
        await expect(service.addCategory('admin-1', 'admin', { name: 'New', parentId: p } as any)).resolves.toMatchObject({ success: true });
      }
    });

    it('refuses a 5th level with a clear message', async () => {
      await expect(service.addCategory('admin-1', 'admin', { name: 'Too deep', parentId: 'L4' } as any)).rejects.toThrow(/at most 4 levels/);
      expect(categoryModel.create).not.toHaveBeenCalled();
    });
  });

  describe('getCategoryTreeNested', () => {
    it('returns the full nested tree with one category query and hides subtrees of inactive parents', async () => {
      const all = [
        { _id: '64f0c0ffee0c0ffee0c0ff33', name: 'R', slug: 'r', parentId: null, status: 'active' },
        { _id: '64f0c0ffee0c0ffee0c0ff16', name: 'A', slug: 'a', parentId: '64f0c0ffee0c0ffee0c0ff33', status: 'active' },
        { _id: '64f0c0ffee0c0ffee0c0ff17', name: 'B', slug: 'b', parentId: '64f0c0ffee0c0ffee0c0ff16', status: 'active' },
        { _id: '64f0c0ffee0c0ffee0c0ff18', name: 'C', slug: 'c', parentId: '64f0c0ffee0c0ffee0c0ff17', status: 'active' },
        { _id: '64f0c0ffee0c0ffee0c0ff39', name: 'X', slug: 'x', parentId: 'inactive-parent', status: 'active' },
      ];
      const sort = jest.fn(() => ({ lean: jest.fn().mockResolvedValue(all) }));
      categoryModel.find = jest.fn(() => ({ sort }));
      productModel.aggregate = jest.fn().mockResolvedValue([]);
      const res: any = await service.getCategoryTreeNested();
      expect(categoryModel.find).toHaveBeenCalledTimes(1);
      expect(res.data).toHaveLength(1);
      expect(res.data[0].children[0].children[0].children[0]._id).toBe('64f0c0ffee0c0ffee0c0ff18');
      const one: any = await service.getCategoryTreeNested('64f0c0ffee0c0ffee0c0ff17');
      expect(one.data.children.map((n: any) => n._id)).toEqual(['64f0c0ffee0c0ffee0c0ff18']);
      await expect(service.getCategoryTreeNested('64f0c0ffee0c0ffee0c0ff39')).rejects.toThrow(NotFoundException);
    });
  });
});
