/* eslint-disable prettier/prettier */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

import { DatabaseService } from 'src/database/databaseservice';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { generateUniqueSlug } from 'src/common/slug.util';
import { ActivityLogService } from 'src/activity-log/activity-log.service';

export interface AdminAuditMeta { adminId: string; ip?: string; userAgent?: string }

@Injectable()
export class CategoriesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private audit(action: string, description: string, meta: AdminAuditMeta, targetId?: string, metadata?: object) {
    void this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      targetType: 'category',
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: metadata ?? null,
    });
  }

  // ── Admin: update / reorder / soft-delete ─────────────────────────────

  /** Admin-only edit. Only the fields below can change — slug stays fixed
   *  (it's a public URL) and parentId can't be moved here. */
  async updateCategory(id: string, dto: UpdateCategoryDto, meta: AdminAuditMeta) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid category id');
    const categoryModel = this.databaseService.repositories.categoryModel;
    const category = await categoryModel.findOne({ _id: id, isDelete: false });
    if (!category) throw new NotFoundException('Category not found');

    const set: Record<string, any> = {};
    if (dto.name !== undefined && dto.name.trim() !== category.name) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Category name cannot be empty');
      const clash = await categoryModel.findOne({
        name, parentId: category.parentId ?? null, isDelete: false, _id: { $ne: id },
      });
      if (clash) throw new ConflictException('A category with this name already exists here');
      set.name = name;
    }
    if (dto.description !== undefined) set.description = dto.description;
    if (dto.image !== undefined) set.image = dto.image;
    if (dto.sortOrder !== undefined) set.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) set.status = dto.isActive ? 'active' : 'inactive';
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to update');

    const updated = await categoryModel.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' });
    this.audit('category_updated', `Updated category "${category.name}"`, meta, id, { changed: Object.keys(set) });
    return { success: true, message: 'Category updated successfully', data: updated };
  }

  /** Bulk display-order update (admin drag-and-drop). */
  async reorderCategories(dto: ReorderCategoriesDto, meta: AdminAuditMeta) {
    const categoryModel = this.databaseService.repositories.categoryModel;
    const ids = dto.items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Duplicate category ids');
    const found = await categoryModel.countDocuments({ _id: { $in: ids }, isDelete: false });
    if (found !== ids.length) throw new NotFoundException('One or more categories were not found');

    await categoryModel.bulkWrite(
      dto.items.map((i) => ({ updateOne: { filter: { _id: i.id }, update: { $set: { sortOrder: i.sortOrder } } } })),
    );
    this.audit('category_reordered', `Reordered ${ids.length} categories`, meta, undefined, { items: dto.items });
    return { success: true, message: 'Categories reordered successfully', data: { updated: ids.length } };
  }

  /** Soft delete. Refuses while the category still has subcategories or is
   *  referenced by products/stores; `reassignTo` (a same-level category)
   *  moves those references first instead. */
  async deleteCategory(id: string, reassignTo: string | undefined, meta: AdminAuditMeta) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid category id');
    const repos = this.databaseService.repositories;
    const category = await repos.categoryModel.findOne({ _id: id, isDelete: false });
    if (!category) throw new NotFoundException('Category not found');

    const children = await repos.categoryModel.countDocuments({ parentId: id, isDelete: false });
    if (children > 0) {
      throw new ConflictException(`Category has ${children} subcategor${children === 1 ? 'y' : 'ies'} — delete or move them first`);
    }

    const isRoot = !category.parentId;
    const productFilter = isRoot ? { categoryId: id } : { subCategoryId: id };
    const storeFilter = { categoryId: id, isDelete: false };
    const [productCount, storeCount] = await Promise.all([
      repos.productModel.countDocuments({ ...productFilter, isDelete: false }),
      isRoot ? repos.storeModel.countDocuments(storeFilter) : Promise.resolve(0),
    ]);

    let reassigned: { products: number; stores: number } | null = null;
    if (productCount + storeCount > 0) {
      if (!reassignTo) {
        throw new ConflictException(
          `Category is still used by ${productCount} product(s) and ${storeCount} store(s). Pass ?reassignTo=<categoryId> to move them.`,
        );
      }
      if (!isValidObjectId(reassignTo) || reassignTo === id) throw new BadRequestException('Invalid reassignTo category');
      const target = await repos.categoryModel.findOne({ _id: reassignTo, isDelete: false, status: 'active' });
      if (!target) throw new BadRequestException('reassignTo category not found or inactive');
      // Same level, and a subcategory may only move within its own root so a
      // product's subCategoryId always stays a child of its categoryId.
      if ((target.parentId ?? null) !== (category.parentId ?? null)) {
        throw new BadRequestException(
          isRoot ? 'reassignTo must be another main category' : 'reassignTo must be a subcategory of the same main category',
        );
      }
      const field = isRoot ? 'categoryId' : 'subCategoryId';
      const p = await repos.productModel.updateMany({ ...productFilter, isDelete: false }, { $set: { [field]: reassignTo } });
      const st = isRoot
        ? await repos.storeModel.updateMany(storeFilter, { $set: { categoryId: reassignTo } })
        : { modifiedCount: 0 };
      reassigned = { products: p.modifiedCount, stores: st.modifiedCount };
    }

    await repos.categoryModel.updateOne({ _id: id }, { $set: { isDelete: true, status: 'inactive' } });
    this.audit('category_deleted', `Deleted category "${category.name}"`, meta, id, { reassignTo: reassignTo ?? null, reassigned });
    return { success: true, message: 'Category deleted successfully', data: { reassigned } };
  }

  /** Admin view of the whole taxonomy: every non-deleted category, active or
   *  inactive (so a deactivated one can be found and re-enabled), nested two
   *  levels and ordered by sortOrder — the same order the public tree uses. */
  async getAdminCategoryTree() {
    const categoryModel = this.databaseService.repositories.categoryModel;
    const [all, countMap] = await Promise.all([
      categoryModel.find({ isDelete: false }).sort({ sortOrder: 1, _id: 1 }).lean(),
      this.getActiveProductCountsByCategory(),
    ]);
    const nodes = new Map<string, any>();
    for (const c of all as any[]) nodes.set(String(c._id), { ...c, children: [] });
    const roots: any[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(String(node.parentId)) : null;
      if (parent) parent.children.push(node);
      else if (!node.parentId) roots.push(node);
      // A child whose parent was deleted is orphaned — not shown, matching the public tree.
    }
    this.attachProductCounts(roots, countMap);
    return { success: true, message: 'Admin category tree fetched successfully', data: roots };
  }

  async addCategory(
    userId: string,
    role: string,
    createCategoryDto: CreateCategoryDto,
  ) {
    // ADMIN CHECK
    if (role === 'admin') {
      const admin = await this.databaseService.repositories.adminModel.findOne({
        _id: userId,
        status: 'active',
        isDelete: false,
      });

      if (!admin) {
        throw new UnauthorizedException('Unauthorized admin');
      }
    }

    // SELLER CHECK
    if (role === 'seller') {
      const seller =
        await this.databaseService.repositories.sellerModel.findOne({
          _id: userId,
          status: 'active',
          isDelete: false,
        });

      if (!seller) {
        throw new UnauthorizedException('Unauthorized seller');
      }
    }

    try {
      const { name, parentId, image, description, sortOrder } =
        createCategoryDto;
      const categoryModel = this.databaseService.repositories.categoryModel;

      // 🔒 Permission model:
      // - Main categories (no parentId) → admin only. This is the curated
      //   top-level taxonomy sellers pick from when creating a store.
      // - Subcategories (parentId set) → admin OR seller, optionally, and
      //   only nested one level under an existing main category (no
      //   sub-of-a-sub — keeps the tree exactly 2 levels deep).
      let parent: any = null;
      if (!parentId) {
        if (role !== 'admin') {
          throw new ForbiddenException(
            'Only admins can create main categories',
          );
        }
      } else {
        parent = await categoryModel.findOne({
          _id: parentId,
          status: 'active',
          isDelete: false,
        });
        if (!parent) {
          throw new BadRequestException('Parent category not found');
        }
        if (parent.parentId) {
          throw new BadRequestException(
            'Categories can only be nested one level deep — pick a main category as the parent',
          );
        }
      }

      // check duplicate category — scoped to the same parent, so the same
      // name can exist under different main categories without colliding.
      const existingCategory = await categoryModel.findOne({
        name,
        parentId: parentId ?? null,
        status: 'active',
        isDelete: false,
      });

      if (existingCategory) {
        throw new ConflictException(
          'A category with this name already exists here',
        );
      }

      const slug = await generateUniqueSlug(categoryModel, name);

      const category = await categoryModel.create({
        name,
        slug,
        parentId: parentId ?? null,
        image: image,
        description: description,
        sortOrder: sortOrder || 0,
        createdBy: userId,
        createdByRole: role,
      });

      return {
        success: true,
        message: 'Category created successfully',
        data: category,
      };
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      throw new BadRequestException(
        error.message || 'Failed to create category',
      );
    }
  }

  // async getChildCategories(parentId: string) {

  //   const categoryModel = this.databaseService.repositories.categoryModel;

  //   const children = await categoryModel.find({ parentId });

  //  let ids: string[] = [];

  // for (let child of children) {

  //   ids.push(child._id.toString());

  //   const subChildren = await this.getChildCategories(child._id.toString());

  //   ids = ids.concat(subChildren);

  // }

  //   return ids;
  // }

  // async getCategoryTree(categoryId: string) {

  //   const categoryModel = this.databaseService.repositories.categoryModel;

  //   // parent category
  //   const parentCategory = await categoryModel.findById(categoryId);

  //   if (!parentCategory) {
  //     throw new UnauthorizedException('Category not found');
  //   }

  //   // saare child ids
  //   const childIds = await this.getChildCategories(categoryId);

  //   // parent + child
  //   const allIds = [categoryId, ...childIds];

  //   // saari categories ka data
  //   const categories = await categoryModel.find({
  //     _id: { $in: allIds }
  //   });

  //   return {
  //     message: "Category tree fetched successfully",
  //     data: categories
  //   };
  // }

  async getCategoryTreeNested(categoryId?: string) {
    const categoryModel = this.databaseService.repositories.categoryModel;

    const countMap = await this.getActiveProductCountsByCategory();

    // 🔹 CASE 1: agar id di hui hai
    if (categoryId) {
      // A non-ObjectId string (e.g. a category name leaking in from stale
      // data) would otherwise throw an unhandled Mongoose CastError here,
      // which Nest surfaces as an opaque 500 — fail with a clear 400 instead.
      if (!isValidObjectId(categoryId)) {
        throw new BadRequestException('Invalid category id');
      }

      const category = await categoryModel.findOne({
        _id: categoryId,
        status: 'active',
        isDelete: false,
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }

      const children = await this.getChildrenRecursive(categoryId);
      const node = { ...category.toObject(), children };
      await this.ensureSlug(node);
      this.attachProductCounts([node], countMap);

      return {
        success: true,
        message: 'Category tree fetched successfully',
        data: node,
      };
    }

    // 🔹 CASE 2: agar id NA ho → sab root categories lao
    const rootCategories = await categoryModel
      .find({
        parentId: null,
        status: 'active',
        isDelete: false,
      })
      .sort({ sortOrder: 1, _id: 1 })
      .lean();

    const result: any[] = [];

    for (const cat of rootCategories) {
      await this.ensureSlug(cat);
      const children = await this.getChildrenRecursive(cat._id.toString());

      result.push({
        ...cat,
        children,
      });
    }

    this.attachProductCounts(result, countMap);

    return {
      success: true,
      message: 'All category trees fetched successfully',
      data: result,
    };
  }

  /** One aggregation over all buyer-visible products, grouped by category — the
   *  building block `attachProductCounts` uses instead of a per-node query. */
  private async getActiveProductCountsByCategory(): Promise<Map<string, number>> {
    const productModel = this.databaseService.repositories.productModel;
    const rows = await productModel.aggregate([
      { $match: { status: 'active', isDelete: false } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r: { _id: string; count: number }) => [r._id, r.count]));
  }

  /** Mutates each node (and its nested `children`) in place, setting
   *  `productCount` to that category's own direct products plus every
   *  descendant's — so a parent category's chip reflects its whole subtree. */
  private attachProductCounts(nodes: any[], countMap: Map<string, number>): number {
    let total = 0;
    for (const node of nodes) {
      const ownCount = countMap.get(String(node._id)) ?? 0;
      const childrenCount = node.children?.length
        ? this.attachProductCounts(node.children, countMap)
        : 0;
      node.productCount = ownCount + childrenCount;
      total += node.productCount;
    }
    return total;
  }
  private async getChildrenRecursive(parentId: string): Promise<any[]> {
    const categoryModel = this.databaseService.repositories.categoryModel;

    const children = await categoryModel.find({
      parentId,
      status: 'active',
      isDelete: false,
    }).sort({ sortOrder: 1, _id: 1 });

    const result: any[] = [];

    for (const child of children) {
      const childObj = child.toObject();
      await this.ensureSlug(childObj);
      const subChildren = await this.getChildrenRecursive(childObj._id.toString());

      result.push({
        ...childObj,
        children: subChildren, // nested inside each child
      });
    }

    return result;
  }

  /** Lazily backfills a permanent, persisted slug for any pre-migration
   *  category found without one — mutates the plain object in place and
   *  writes it to the DB so it's stable from then on (never recomputed). */
  private async ensureSlug(cat: any): Promise<void> {
    if (cat.slug) return;
    const categoryModel = this.databaseService.repositories.categoryModel;
    const slug = await generateUniqueSlug(categoryModel, cat.name, {
      excludeId: String(cat._id),
    });
    await categoryModel.findByIdAndUpdate(cat._id, { slug });
    cat.slug = slug;
  }

  async getCategoryWithChildren(categoryId: string): Promise<any> {
    const categoryModel = this.databaseService.repositories.categoryModel;

    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }

    // Parent category (only active & not deleted)
    const category = await categoryModel.findOne({
      _id: categoryId,
      status: 'active',
      isDelete: false,
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Direct children (only active & not deleted)
    const children = await categoryModel.find({
      parentId: categoryId,
      status: 'active',
      isDelete: false,
    });

    return {
      success: true,
      message: 'Category with children fetched successfully',
      data: {
        category, // parent category
        children, // flat array of direct children
      },
    };
  }

  async getAllCategories(): Promise<any> {
    const categoryModel = this.databaseService.repositories.categoryModel;

    // sirf active aur not deleted categories
    const categories = await categoryModel.find({
      status: 'active',
      isDelete: false,
    });

    return {
      success: true,
      message: 'All categories fetched successfully',
      data: categories,
    };
  }
}
