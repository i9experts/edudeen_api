/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { normalizeCollectionName, MAX_COLLECTIONS_PER_STORE } from './collection-name.util';
import { ReorderCollectionsDto } from './dto/reorder-collections.dto';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { slugify } from '../common/slug.util';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { UpdateCollectionProductsDto } from './dto/update-collection-products.dto';

// Real cap on how many products an `automatic` collection resolves to at
// read time — same "bounded, not unlimited" spirit as other placement caps
// in the codebase (e.g. Store.pinnedProductIds' PlatformConfig.placementLimits).
const AUTOMATIC_COLLECTION_PRODUCT_CAP = 250;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Slug uniqueness is scoped to ONE store here (unlike Store/Category's
   *  global generateUniqueSlug()) — a Collection is always a child of a
   *  single store, so two different stores each having a "sale" collection
   *  is completely fine. */
  private async generateStoreScopedSlug(storeId: string, name: string, excludeId?: string): Promise<string> {
    const base = slugify(name) || 'collection';
    let slug = base;
    let n = 1;
    while (
      await this.r.collectionModel.findOne({
        storeId,
        slug,
        isDelete: false,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      })
    ) {
      slug = `${base}-${n}`;
      n++;
    }
    return slug;
  }

  private async findOwned(storeId: string, sellerId: string, collectionId: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const collection = await this.r.collectionModel.findOne({ _id: collectionId, storeId, isDelete: false });
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  /** Rejects a name whose normalised form matches another live collection of the SAME store. Compares against the
   *  computed form of every name (not only the stored field) so collections created before `normalizedName` existed
   *  still count. A store has at most 20, so the scan is cheap. Race-proofing = the unique index added after cleanup. */
  private async assertNameFree(storeId: string, name: string, excludeId?: string) {
    const key = normalizeCollectionName(name);
    if (!key) throw new BadRequestException('Collection name must contain letters or numbers');
    const existing = await this.r.collectionModel.find({ storeId, isDelete: false }).select('name').lean();
    const clash = existing.some((c: any) => String(c._id) !== excludeId && normalizeCollectionName(c.name) === key);
    if (clash) throw new ConflictException('This collection already exists');
  }

  // ── Seller ─────────────────────────────────────────────────────────────

  async create(storeId: string, sellerId: string, dto: CreateCollectionDto) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const liveCount = await this.r.collectionModel.countDocuments({ storeId, isDelete: false });
    if (liveCount >= MAX_COLLECTIONS_PER_STORE) {
      throw new BadRequestException(`You can have at most ${MAX_COLLECTIONS_PER_STORE} collections. Delete one first.`);
    }
    await this.assertNameFree(storeId, dto.name);
    if (dto.type === 'manual' && (!dto.productIds || dto.productIds.length === 0)) {
      throw new BadRequestException('A manual collection needs at least one product — add products after creating it, or switch to automatic.');
    }
    const slug = await this.generateStoreScopedSlug(storeId, dto.name);

    const collection = await this.r.collectionModel.create({
      storeId,
      name: dto.name,
      normalizedName: normalizeCollectionName(dto.name),
      sortOrder: liveCount,
      slug,
      description: dto.description ?? null,
      image: dto.image ?? null,
      type: dto.type,
      productIds: dto.type === 'manual' ? (dto.productIds ?? []) : [],
      rules: dto.type === 'automatic' ? { categoryId: dto.rules?.categoryId ?? null, tags: dto.rules?.tags ?? [], matchType: dto.rules?.matchType ?? 'any' } : undefined,
    });

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'collection_created',
      description: `${dto.name} (${dto.type})`, actorId: sellerId, actorRole: 'seller',
      targetId: String(collection._id), targetType: 'collection',
    });

    return { success: true, message: 'Collection created', data: collection };
  }

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const collections = await this.r.collectionModel.find({ storeId, isDelete: false }).sort({ sortOrder: 1, createdAt: -1 }).lean();
    return { success: true, data: collections };
  }

  async getForSeller(storeId: string, sellerId: string, collectionId: string) {
    const collection = await this.findOwned(storeId, sellerId, collectionId);
    return { success: true, data: collection };
  }

  async update(storeId: string, sellerId: string, collectionId: string, dto: UpdateCollectionDto) {
    const collection = await this.findOwned(storeId, sellerId, collectionId);

    const set: Record<string, unknown> = {};
    if (dto.name !== undefined && dto.name !== collection.name) {
      await this.assertNameFree(storeId, dto.name, collectionId);
      set.name = dto.name;
      set.normalizedName = normalizeCollectionName(dto.name);
      set.slug = await this.generateStoreScopedSlug(storeId, dto.name, collectionId);
    }
    if (dto.description !== undefined) set.description = dto.description;
    if (dto.image !== undefined) set.image = dto.image;
    if (dto.type !== undefined) set.type = dto.type;
    if (dto.rules !== undefined) {
      set.rules = { categoryId: dto.rules.categoryId ?? null, tags: dto.rules.tags ?? [], matchType: dto.rules.matchType ?? 'any' };
    }
    if (dto.status !== undefined) set.status = dto.status;

    const updated = await this.r.collectionModel.findByIdAndUpdate(collectionId, { $set: set }, { returnDocument: 'after' });

    const changes: string[] = [];
    if (set.name) changes.push(`renamed "${collection.name}" -> "${dto.name}"`);
    if (dto.status !== undefined && dto.status !== collection.status) changes.push(dto.status === 'draft' ? 'hidden from store' : 'shown on store');
    if (dto.type !== undefined || dto.rules !== undefined || dto.description !== undefined || dto.image !== undefined) changes.push('details edited');
    if (changes.length) {
      await this.activityLogService.log({
        storeId, category: 'marketing', action: 'collection_updated',
        description: `${collection.name}: ${changes.join(', ')}`, actorId: sellerId, actorRole: 'seller',
        targetId: collectionId, targetType: 'collection',
      });
    }
    return { success: true, message: 'Collection updated', data: updated };
  }

  /** Saves the seller's display order. Must list ONLY this store's live collections; anything else is rejected, so an
   *  id from another store can never be touched. Ids not listed (none expected) keep their place after the listed ones. */
  async reorder(storeId: string, sellerId: string, dto: ReorderCollectionsDto) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const owned = await this.r.collectionModel.find({ storeId, isDelete: false, _id: { $in: dto.ids } }).select('_id').lean();
    if (owned.length !== dto.ids.length) throw new BadRequestException('Some collections were not found in your store');
    await this.r.collectionModel.bulkWrite(
      dto.ids.map((id, i) => ({ updateOne: { filter: { _id: id, storeId }, update: { $set: { sortOrder: i } } } })),
    );
    await this.activityLogService.log({
      storeId, category: 'marketing', action: 'collections_reordered',
      description: `${dto.ids.length} collections`, actorId: sellerId, actorRole: 'seller',
      targetId: null, targetType: 'collection',
    });
    return { success: true, message: 'Order saved' };
  }

  async updateProducts(storeId: string, sellerId: string, collectionId: string, dto: UpdateCollectionProductsDto) {
    const collection = await this.findOwned(storeId, sellerId, collectionId);
    if (collection.type !== 'manual') {
      throw new BadRequestException('Only a manual collection has a directly-editable product list — an automatic collection resolves its products from its rules.');
    }
    const updated = await this.r.collectionModel.findByIdAndUpdate(
      collectionId,
      { $set: { productIds: dto.productIds } },
      { returnDocument: 'after' },
    );
    return { success: true, message: 'Collection products updated', data: updated };
  }

  async delete(storeId: string, sellerId: string, collectionId: string) {
    const collection = await this.findOwned(storeId, sellerId, collectionId);
    await this.r.collectionModel.findByIdAndUpdate(collectionId, { $set: { isDelete: true } });
    this.activityLogService.log({
      storeId, category: 'marketing', action: 'collection_deleted',
      description: collection.name, actorId: sellerId, actorRole: 'seller',
      targetId: collectionId, targetType: 'collection',
    });
    return { success: true, message: 'Collection deleted' };
  }

  // ── Product resolution (shared by public collection pages, the
  // FeaturedProductsSection 'collection' source, and ProductCatalogSection's
  // collectionId filter) — returns product ids only; callers already have
  // their own product-shaping (variants/seller/campaign pricing) pipeline
  // via StoreService.getPublicStoreProducts, so this deliberately does not
  // duplicate that. ─────────────────────────────────────────────────────

  async resolveProductIds(storeId: string, collectionIdOrSlug: string): Promise<string[]> {
    // Callers pass whatever a `FeaturedProductsSection`/`ProductCatalogSection`
    // settings field or a `CollectionDetailPage` route param happens to hold —
    // usually a real id (picked via `EntityPickerModal`), but the storefront
    // route resolves by slug-or-id (Phase 11), so this must accept either,
    // same `isValidObjectId` guard as `getPublicBySlug`/`findByIdOrSlugForStore`.
    const collection = await this.r.collectionModel.findOne({
      storeId, isDelete: false, status: 'active',
      $or: isValidObjectId(collectionIdOrSlug) ? [{ slug: collectionIdOrSlug }, { _id: collectionIdOrSlug }] : [{ slug: collectionIdOrSlug }],
    }).lean();
    if (!collection) return [];

    // A collection of a pending/suspended store resolves to nothing.
    if (!(await this.r.storeModel.exists({ _id: storeId, status: 'active', isDelete: false }))) return [];
    if (collection.type === 'manual') {
      if (collection.productIds.length === 0) return [];
      // Preserve the seller's chosen order, but only ever include products
      // that are still real/active — a collection never silently shows a
      // deleted/archived product.
      const active = await this.r.productModel
        .find({ _id: { $in: collection.productIds }, storeId, isDelete: false, status: 'active' })
        .select('_id')
        .lean();
      const activeIds = new Set(active.map((p: any) => p._id.toString()));
      return collection.productIds.filter((id) => activeIds.has(id));
    }

    // automatic
    const filter: any = { storeId, isDelete: false, status: 'active' };
    const clauses: any[] = [];
    if (collection.rules?.categoryId) clauses.push({ categoryId: collection.rules.categoryId });
    if (collection.rules?.tags?.length) clauses.push({ tags: { $in: collection.rules.tags } });
    if (clauses.length > 0) {
      filter[collection.rules.matchType === 'all' ? '$and' : '$or'] = clauses;
    }
    const products = await this.r.productModel
      .find(filter)
      .select('_id')
      .sort({ createdAt: -1 })
      .limit(AUTOMATIC_COLLECTION_PRODUCT_CAP)
      .lean();
    return products.map((p: any) => p._id.toString());
  }

  /** `idOrSlug` matches either — never casts a non-ObjectId string into the
   *  `_id` clause (would throw a Mongoose CastError), same guard pattern
   *  `ProductsService.getProductById` already uses for its own slug-or-id
   *  resolution. Used by nav links (Phase 4), which store a `collectionId`,
   *  not a slug. */
  async findByIdOrSlugForStore(storeId: string, idOrSlug: string) {
    return this.r.collectionModel.findOne({
      storeId,
      isDelete: false,
      status: 'active',
      $or: isValidObjectId(idOrSlug) ? [{ slug: idOrSlug }, { _id: idOrSlug }] : [{ slug: idOrSlug }],
    }).lean();
  }

  // ── Public ─────────────────────────────────────────────────────────────

  async listPublic(storeId: string) {
    const collections = await this.r.collectionModel
      .find({ storeId, isDelete: false, status: 'active' })
      .select('name slug description image type sortOrder seo')
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    return { success: true, data: collections };
  }

  /** Accepts a real slug OR an id — a nav link/section stores `collectionId`
   *  (Phase 4/3b), so the storefront's `/collections/:slugOrId` route
   *  (Phase 11) needs to resolve either, exactly like `/category/:slugOrId`
   *  already does for categories. */
  async getPublicBySlug(storeId: string, slugOrId: string) {
    const collection = await this.r.collectionModel
      .findOne({
        storeId,
        isDelete: false,
        status: 'active',
        $or: isValidObjectId(slugOrId) ? [{ slug: slugOrId }, { _id: slugOrId }] : [{ slug: slugOrId }],
      })
      .select('name slug description image type seo')
      .lean();
    if (!collection) throw new NotFoundException('Collection not found');
    return { success: true, data: collection };
  }
}
