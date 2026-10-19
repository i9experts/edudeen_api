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
import {
  MAX_CATEGORY_DEPTH,
  getAncestorChain,
  getDescendantIds,
  invalidateCategoryTreeCache,
  nestCategories,
} from './category-tree.util';

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
   *  (it's a public URL) and parentId can't be moved here. Works at any depth. */
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

  /** Bulk display-order update (admin drag-and-drop / up-down). Works for siblings at any depth. */
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

  /** Soft delete. Refuses while the category still has subcategories (at any depth) unless
   *  `deleteChildren` is set, and while products/stores use it (or anything below it) unless
   *  `reassignTo` names a category to move them to first. */
  async deleteCategory(id: string, reassignTo: string | undefined, meta: AdminAuditMeta, deleteChildren = false) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid category id');
    const repos = this.databaseService.repositories;
    const category = await repos.categoryModel.findOne({ _id: id, isDelete: false });
    if (!category) throw new NotFoundException('Category not found');

    invalidateCategoryTreeCache();
    const subtree = await getDescendantIds(repos.categoryModel, id); // includes id itself
    const descendantCount = subtree.length - 1;
    if (descendantCount > 0 && !deleteChildren) {
      throw new ConflictException(
        `Category has ${descendantCount} subcategor${descendantCount === 1 ? 'y' : 'ies'} below it — delete or move them first, or confirm deleting them together`,
      );
    }

    const isRoot = !category.parentId;
    const productFilter = isRoot ? { categoryId: id } : { subCategoryId: { $in: subtree } };
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

      let productSet: Record<string, any>;
      if (isRoot) {
        // A main category's products can only move to another main category.
        if (target.parentId) throw new BadRequestException('reassignTo must be another main category');
        productSet = { categoryId: reassignTo, subCategoryId: null };
      } else {
        // Inside one main category: the target may be any node of the same root that is not being deleted
        // (a sibling, the parent, or the main category itself = "no subcategory"), so a product's
        // subCategoryId always stays a descendant of its categoryId.
        if (subtree.includes(reassignTo)) throw new BadRequestException('reassignTo cannot be inside the category being deleted');
        const [myChain, targetChain] = await Promise.all([
          getAncestorChain(repos.categoryModel, id),
          getAncestorChain(repos.categoryModel, reassignTo),
        ]);
        const myRoot = myChain[myChain.length - 1] ?? String(category.parentId);
        const targetRoot = targetChain[targetChain.length - 1] ?? String(target.parentId ?? reassignTo);
        if (myRoot !== targetRoot) throw new BadRequestException('reassignTo must be in the same main category');
        productSet = { subCategoryId: target.parentId ? reassignTo : null };
      }
      const p = await repos.productModel.updateMany({ ...productFilter, isDelete: false }, { $set: productSet });
      const st = isRoot
        ? await repos.storeModel.updateMany(storeFilter, { $set: { categoryId: reassignTo } })
        : { modifiedCount: 0 };
      reassigned = { products: p.modifiedCount, stores: st.modifiedCount };
    }

    if (descendantCount > 0) {
      await repos.categoryModel.updateMany({ _id: { $in: subtree } }, { $set: { isDelete: true, status: 'inactive' } });
    } else {
      await repos.categoryModel.updateOne({ _id: id }, { $set: { isDelete: true, status: 'inactive' } });
    }
    invalidateCategoryTreeCache();
    this.audit('category_deleted', `Deleted category "${category.name}"${descendantCount ? ` and ${descendantCount} subcategories` : ''}`, meta, id, {
      reassignTo: reassignTo ?? null, reassigned, deletedChildren: descendantCount,
    });
    return { success: true, message: 'Category deleted successfully', data: { reassigned, deletedChildren: descendantCount } };
  }

  /** Admin view of the whole taxonomy: every non-deleted category, active or
   *  inactive (so a deactivated one can be found and re-enabled), nested to any
   *  depth and ordered by sortOrder — the same order the public tree uses. */
  async getAdminCategoryTree() {
    const categoryModel = this.databaseService.repositories.categoryModel;
    const [all, counts] = await Promise.all([
      categoryModel.find({ isDelete: false }).sort({ sortOrder: 1, _id: 1 }).lean(),
      this.getActiveProductCounts(),
    ]);
    // A child whose parent was deleted is orphaned — not shown, matching the public tree.
    const roots = nestCategories(all as any[]);
    this.attachProductCounts(roots, counts, true);
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
      // - Subcategories (parentId set) → admin OR seller, nested under any
      //   active category as long as the whole chain stays within
      //   MAX_CATEGORY_DEPTH levels (main > sub > sub-sub > sub-sub-sub).
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
        // Depth of the parent = number of nodes from it up to its root.
        let depth = 1;
        let cursor: any = parent;
        while (cursor?.parentId && depth <= MAX_CATEGORY_DEPTH) {
          cursor = await categoryModel.findOne({ _id: cursor.parentId, isDelete: false });
          depth++;
        }
        if (depth + 1 > MAX_CATEGORY_DEPTH) {
          throw new BadRequestException(
            `Categories can be nested at most ${MAX_CATEGORY_DEPTH} levels deep — "${parent.name}" is already at level ${depth}, so it cannot have subcategories`,
          );
        }
      }

      // check duplicate category — scoped to the same parent, so the same
      // name can exist under different parents without colliding.
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
      invalidateCategoryTreeCache();

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

  /** Public tree: every ACTIVE category nested to any depth. One query (not one per node), so it stays fast
   *  however many categories exist. A node under an inactive/deleted parent is hidden with it. */
  async getCategoryTreeNested(categoryId?: string) {
    const categoryModel = this.databaseService.repositories.categoryModel;

    // A non-ObjectId string (e.g. a category name leaking in from stale data) would otherwise throw an
    // unhandled Mongoose CastError, which Nest surfaces as an opaque 500 — fail with a clear 400 instead.
    if (categoryId && !isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }

    const [rows, counts] = await Promise.all([
      categoryModel.find({ status: 'active', isDelete: false }).sort({ sortOrder: 1, _id: 1 }).lean(),
      this.getActiveProductCounts(),
    ]);
    const roots = nestCategories(rows as any[]);

    // Backfill a permanent slug for any pre-migration category found without one.
    const walk = (nodes: any[], fn: (n: any) => void) => { for (const n of nodes) { fn(n); walk(n.children, fn); } };
    const missingSlug: any[] = [];
    walk(roots, (n) => { if (!n.slug) missingSlug.push(n); });
    for (const n of missingSlug) await this.ensureSlug(n);

    this.attachProductCounts(roots, counts, true);

    if (categoryId) {
      let found: any = null;
      walk(roots, (n) => { if (!found && String(n._id) === categoryId) found = n; });
      if (!found) throw new NotFoundException('Category not found');
      return { success: true, message: 'Category tree fetched successfully', data: found };
    }

    return { success: true, message: 'All category trees fetched successfully', data: roots };
  }

  /** One aggregation pass over all buyer-visible products. `root` counts per main category (every product has one);
   *  `sub` counts per exact subCategoryId (any depth). */
  private async getActiveProductCounts(): Promise<{ root: Map<string, number>; sub: Map<string, number>; rootCover: Map<string, string[]>; subCover: Map<string, string[]> }> {
    const productModel = this.databaseService.repositories.productModel;
    const base = { status: 'active', isDelete: false, isTest: { $ne: true } };
    // Up to 4 covers = first photo of the best-selling (then newest) products that have one.
    const coverGroup = (field: string, extra: object = {}): any[] => [
      { $match: { ...base, ...extra, 'images.0': { $exists: true } } },
      { $sort: { purchaseCount: -1, _id: -1 } },
      { $group: { _id: field, covers: { $push: { $arrayElemAt: ['$images', 0] } } } },
      { $project: { covers: { $slice: ['$covers', 4] } } },
    ];
    const [rootRows, subRows, rootCovers, subCovers] = await Promise.all([
      productModel.aggregate([
        { $match: base },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
      ]),
      productModel.aggregate([
        { $match: { ...base, subCategoryId: { $ne: null } } },
        { $group: { _id: '$subCategoryId', count: { $sum: 1 } } },
      ]),
      productModel.aggregate(coverGroup('$categoryId')),
      productModel.aggregate(coverGroup('$subCategoryId', { subCategoryId: { $ne: null } })),
    ]);
    const toMap = (rows: { _id: string; count: number }[]) => new Map<string, number>((rows ?? []).map((r) => [String(r._id), r.count]));
    const toCover = (rows: { _id: string; covers: string[] }[]) => new Map<string, string[]>((rows ?? []).filter((r) => r.covers?.length).map((r) => [String(r._id), r.covers]));
    return { root: toMap(rootRows), sub: toMap(subRows), rootCover: toCover(rootCovers), subCover: toCover(subCovers) };
  }

  /** Mutates each node (and its nested `children`) in place, setting `productCount`: for a main category every
   *  product filed under it; for a subcategory its own products plus every descendant's. */
  private attachProductCounts(nodes: any[], counts: { root: Map<string, number>; sub: Map<string, number>; rootCover: Map<string, string[]>; subCover: Map<string, string[]> }, isRoot = false): number {
    let total = 0;
    for (const node of nodes) {
      const id = String(node._id);
      const childrenCount = node.children?.length ? this.attachProductCounts(node.children, counts, false) : 0;
      // Up to 4 real product photos for tiles; a parent short of photos tops up from its descendants.
      const covers: string[] = [...((isRoot ? counts.rootCover.get(id) : counts.subCover.get(id)) ?? [])];
      for (const c of node.children ?? []) for (const u of c.coverImages ?? []) if (covers.length < 4 && !covers.includes(u)) covers.push(u);
      node.coverImages = covers;
      node.coverImage = covers[0] ?? null;
      node.productCount = isRoot ? (counts.root.get(id) ?? 0) : (counts.sub.get(id) ?? 0) + childrenCount;
      total += node.productCount;
    }
    return total;
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
