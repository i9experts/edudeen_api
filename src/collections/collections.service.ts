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
import {
  cleanCollectionRules, cleanCollectionSort, cleanCollectionWindow, collectionWindowState,
  evaluateCollectionIds, liveWindowClause, CollectionLike,
} from './collection-rules.util';

const PREVIEW_THUMBS = 8;
const trimOrNull = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

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
    // Validate every smart rule / sort / schedule BEFORE writing (bad value = 400).
    const rules = dto.type === 'automatic' ? cleanCollectionRules(dto.rules) : undefined;
    const sortBy = cleanCollectionSort(dto.sortBy);
    const { startAt, endAt } = cleanCollectionWindow(dto.startAt, dto.endAt);

    const collection = await this.r.collectionModel.create({
      sortBy, startAt, endAt,
      // The seller form creates "Show on store" collections and only follows up with status:'draft' for hidden ones;
      // the schema default is 'draft', so without this a new visible collection never appeared on the store.
      status: 'active',
      nameUr: trimOrNull(dto.nameUr, 100),
      descriptionUr: trimOrNull(dto.descriptionUr, 500),
      storeId,
      name: dto.name,
      normalizedName: normalizeCollectionName(dto.name),
      sortOrder: liveCount,
      slug,
      description: dto.description ?? null,
      image: dto.image ?? null,
      type: dto.type,
      productIds: dto.type === 'manual' ? (dto.productIds ?? []) : [],
      rules,
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
    const now = new Date();
    // Same evaluator as the store tab, so the number here == what buyers see (max 20 collections per store).
    const data = await Promise.all(collections.map(async (c: any) => ({
      ...c,
      windowState: collectionWindowState(c, now),
      productCount: (await evaluateCollectionIds(this.r, storeId, c as CollectionLike, now)).length,
    })));
    return { success: true, data };
  }

  /** Live preview for the New/Edit modal: nothing is saved. Same evaluator as the store tab and the count. */
  async preview(storeId: string, sellerId: string, body: any) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const type = body?.type === 'automatic' ? 'automatic' : body?.type === 'manual' ? 'manual' : null;
    if (!type) throw new BadRequestException('type must be manual or automatic');
    const productIds = Array.isArray(body?.productIds) ? body.productIds.filter((x: unknown) => typeof x === 'string' && isValidObjectId(x)).slice(0, 500) : [];
    const col: CollectionLike = {
      type,
      productIds,
      rules: type === 'automatic' ? cleanCollectionRules(body?.rules) : null,
      sortBy: cleanCollectionSort(body?.sortBy),
    };
    const ids = await evaluateCollectionIds(this.r, storeId, col);
    const head = ids.slice(0, PREVIEW_THUMBS);
    const docs: any[] = head.length ? await this.r.productModel.find({ _id: { $in: head }, storeId }).select('name images').lean() : [];
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const products = head.map((id) => byId.get(id)).filter(Boolean).map((d: any) => ({ _id: String(d._id), name: d.name, image: d.images?.[0] ?? null }));
    return { success: true, data: { count: ids.length, products } };
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
    if (dto.rules !== undefined) set.rules = cleanCollectionRules(dto.rules);
    if (dto.sortBy !== undefined) set.sortBy = cleanCollectionSort(dto.sortBy);
    if (dto.nameUr !== undefined) set.nameUr = trimOrNull(dto.nameUr, 100);
    if (dto.descriptionUr !== undefined) set.descriptionUr = trimOrNull(dto.descriptionUr, 500);
    let scheduleChanged = false;
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      const w = cleanCollectionWindow(
        dto.startAt !== undefined ? dto.startAt : (collection as any).startAt,
        dto.endAt !== undefined ? dto.endAt : (collection as any).endAt,
      );
      set.startAt = w.startAt;
      set.endAt = w.endAt;
      scheduleChanged = true;
    }
    if (dto.status !== undefined) set.status = dto.status;

    const updated = await this.r.collectionModel.findByIdAndUpdate(collectionId, { $set: set }, { returnDocument: 'after' });

    const changes: string[] = [];
    if (set.name) changes.push(`renamed "${collection.name}" -> "${dto.name}"`);
    if (dto.status !== undefined && dto.status !== collection.status) changes.push(dto.status === 'draft' ? 'hidden from store' : 'shown on store');
    if (scheduleChanged) changes.push('schedule changed');
    if (dto.sortBy !== undefined) changes.push('sort changed');
    if (dto.type !== undefined || dto.rules !== undefined || dto.description !== undefined || dto.image !== undefined || dto.nameUr !== undefined || dto.descriptionUr !== undefined) changes.push('details edited');
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
    return (await this.resolveForStore(storeId, collectionIdOrSlug)).ids;
  }

  /** ids in the collection's own order. `useOrder` = the seller chose a sort (old collections: false, so the
   *  store tab keeps its newest-first paging exactly as before). Hidden while outside its schedule window. */
  async resolveForStore(storeId: string, collectionIdOrSlug: string): Promise<{ ids: string[]; useOrder: boolean }> {
    // Callers pass whatever a `FeaturedProductsSection`/`ProductCatalogSection`
    // settings field or a `CollectionDetailPage` route param happens to hold —
    // usually a real id (picked via `EntityPickerModal`), but the storefront
    // route resolves by slug-or-id (Phase 11), so this must accept either,
    // same `isValidObjectId` guard as `getPublicBySlug`/`findByIdOrSlugForStore`.
    const collection = await this.r.collectionModel.findOne({
      storeId, isDelete: false, status: 'active',
      ...liveWindowClause(),
      $or: isValidObjectId(collectionIdOrSlug) ? [{ slug: collectionIdOrSlug }, { _id: collectionIdOrSlug }] : [{ slug: collectionIdOrSlug }],
    }).lean();
    if (!collection) return { ids: [], useOrder: false };

    // A collection of a pending/suspended store resolves to nothing.
    if (!(await this.r.storeModel.exists({ _id: storeId, status: 'active', isDelete: false }))) return { ids: [], useOrder: false };
    // ONE evaluator (collection-rules.util) — never a deleted/inactive/test product.
    const ids = await evaluateCollectionIds(this.r, storeId, collection as unknown as CollectionLike);
    return { ids, useOrder: !!(collection as any).sortBy };
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
      ...liveWindowClause(),
      $or: isValidObjectId(idOrSlug) ? [{ slug: idOrSlug }, { _id: idOrSlug }] : [{ slug: idOrSlug }],
    }).lean();
  }

  // ── Public ─────────────────────────────────────────────────────────────

  async listPublic(storeId: string) {
    const collections = await this.r.collectionModel
      .find({ storeId, isDelete: false, status: 'active', ...liveWindowClause() })
      .select('name slug description image type sortOrder seo nameUr descriptionUr')
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
        ...liveWindowClause(),
        $or: isValidObjectId(slugOrId) ? [{ slug: slugOrId }, { _id: slugOrId }] : [{ slug: slugOrId }],
      })
      .select('name slug description image type seo nameUr descriptionUr')
      .lean();
    if (!collection) throw new NotFoundException('Collection not found');
    return { success: true, data: collection };
  }
}
