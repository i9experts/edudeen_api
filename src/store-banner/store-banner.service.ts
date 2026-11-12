/* eslint-disable prettier/prettier */
import { isStoreLive } from 'src/common/store-live.util';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { DatabaseService } from '../database/databaseservice';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { MediaLibraryService } from '../media-library/media-library.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { validateCreativeDimensions } from '../common/validate-creative-dimensions.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { CreateStoreBannerDto } from './dto/create-store-banner.dto';
import { UpdateStoreBannerDto } from './dto/update-store-banner.dto';
import { StoreBannerStatus } from './schemas/store-banner.schema';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { isSafeLinkTarget } from '../common/link-target.util';
import { MAX_ACTIVE_STORE_SLIDES, SLOT_STATUSES, cleanSlideLink, holdsSlot, isSlotStatus, validateReorderIds, type CleanLink } from './store-banner-rules.util';

const SLOT_FULL_MESSAGE = `A store can show at most ${MAX_ACTIVE_STORE_SLIDES} banner slides at once. Pause or delete one first.`;

// Master stored well above any real viewport (incl. retina/4K) — the frontend
// never fetches this directly, it requests per-breakpoint Cloudinary
// derivatives (see cloudinaryImage.ts), so a generous master costs nothing in
// visitor bandwidth, only Cloudinary storage.
const HERO_MAX_DIMENSION = 2560;
const HERO_MIN_SOURCE_WIDTH = 1280;
const MOBILE_HERO_MAX_DIMENSION = 1440;
const MOBILE_HERO_MIN_SOURCE_WIDTH = 640;

function computeInitialStatus(startAt?: string, endAt?: string): StoreBannerStatus {
  if (endAt && new Date(endAt).getTime() < Date.now()) {
    throw new BadRequestException('endAt is in the past');
  }
  if (startAt && new Date(startAt).getTime() > Date.now()) return 'scheduled';
  return 'active';
}

@Injectable()
export class StoreBannerService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
    private readonly mediaLibraryService: MediaLibraryService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get storeBannerModel() {
    return this.databaseService.repositories.storeBannerModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  private log(storeId: string, action: string, description: string, sellerId: string, targetId: string) {
    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action,
      description,
      actorId: sellerId,
      actorRole: 'seller',
      targetId,
      targetType: 'store_banner',
    });
  }

  // ── PUBLIC read (storefront) ────────────────────────────────────────────────

  async findActiveForStore(storeId: string) {
    if (!(await isStoreLive(this.storeModel, storeId))) return { success: true, count: 0, data: [] };
    const limit = Math.min(await this.adminConfigService.getPlacementLimit('storeHero'), MAX_ACTIVE_STORE_SLIDES);
    const now = new Date();
    const notEnded = { $or: [{ endAt: null }, { endAt: { $gt: now } }] };
    const banners: any[] = await this.storeBannerModel
      .find({
        storeId,
        $and: [
          notEnded,
          { $or: [{ status: 'active' }, { status: 'scheduled', startAt: { $lte: now } }] },
        ],
      })
      .sort({ priority: -1, order: 1 })
      .limit(limit)
      .lean();
    const data = await this.withResolvedLinks(storeId, banners);
    return { success: true, count: data.length, data };
  }

  /** Adds `linkPath` (an in-site path) to each banner. Product / collection links are re-checked here, so a product that
   *  was deleted or unpublished after the slide was saved simply stops linking. Legacy https links pass through. */
  private async withResolvedLinks(storeId: string, banners: any[]) {
    const productIds = banners.filter((b) => b.linkType === 'product' && b.linkTarget).map((b) => String(b.linkTarget));
    const collectionIds = banners.filter((b) => b.linkType === 'collection' && b.linkTarget).map((b) => String(b.linkTarget));
    const [products, collections] = await Promise.all([
      productIds.length
        ? this.databaseService.repositories.productModel
            .find({ _id: { $in: productIds }, storeId, status: 'active', isDelete: { $ne: true }, isTest: { $ne: true } })
            .select('slug').lean()
        : [],
      collectionIds.length
        ? this.databaseService.repositories.collectionModel.find({ _id: { $in: collectionIds }, storeId, isDelete: false, status: 'active' }).select('_id').lean()
        : [],
    ]);
    const slugById = new Map((products as any[]).map((p) => [String(p._id), p.slug as string]));
    const liveCollections = new Set((collections as any[]).map((c) => String(c._id)));
    return banners.map((b) => {
      let linkPath: string | null = null;
      if (b.linkType === 'product') {
        const slug = slugById.get(String(b.linkTarget));
        if (slug) linkPath = `/product/${slug}`;
      } else if (b.linkType === 'collection') {
        if (liveCollections.has(String(b.linkTarget))) linkPath = `/collections/${b.linkTarget}`;
      } else if (b.linkType === 'external' && typeof b.linkTarget === 'string' && /^https:\/\//i.test(b.linkTarget) && isSafeLinkTarget(b.linkTarget)) {
        linkPath = b.linkTarget; // legacy slide saved before links were limited to own products / collections
      }
      return { ...b, linkPath };
    });
  }

  /** The target must be one of THIS store's live products / active collections. */
  private async assertOwnLiveLink(storeId: string, link: NonNullable<CleanLink>) {
    const repos = this.databaseService.repositories;
    const ok = link.linkType === 'product'
      ? await repos.productModel.exists({ _id: link.linkTarget, storeId, status: 'active', isDelete: { $ne: true }, isTest: { $ne: true } })
      : await repos.collectionModel.exists({ _id: link.linkTarget, storeId, isDelete: false, status: 'active' });
    if (!ok) throw new BadRequestException(`That ${link.linkType} is not one of your live ${link.linkType}s`);
  }

  private cleanLink(linkType: unknown, linkTarget: unknown): CleanLink {
    return cleanSlideLink(linkType, linkTarget, (m) => { throw new BadRequestException(m); });
  }

  private slotCount(storeId: string, excludeId?: string) {
    return this.storeBannerModel.countDocuments({ storeId, status: { $in: [...SLOT_STATUSES] }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  }

  /** After a write that made `bannerId` slot-holding: two parallel requests can both pass the count check, so confirm the
   *  banner is among the first MAX (oldest first) and otherwise undo it. Returns false when it had to be undone. */
  private async keepsSlot(storeId: string, bannerId: string): Promise<boolean> {
    const live = await this.storeBannerModel.find({ storeId, status: { $in: [...SLOT_STATUSES] } }).sort({ createdAt: 1, _id: 1 }).select('_id').lean();
    return holdsSlot(live.map((b: any) => String(b._id)), bannerId);
  }

  // ── SELLER CRUD ──────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const banners = await this.storeBannerModel.find({ storeId }).sort({ priority: -1, order: 1 }).lean();
    return { success: true, data: banners };
  }

  async create(storeId: string, sellerId: string, dto: CreateStoreBannerDto, file: Express.Multer.File | undefined, mobileFile?: Express.Multer.File) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    await this.entitlementsService.assertCanCreateStoreBanner(storeId);
    // Before the upload, so a bad link or a full carousel leaves no orphan asset.
    const link = this.cleanLink(dto.linkType, dto.linkTarget);
    if (link) await this.assertOwnLiveLink(storeId, link);
    const status = computeInitialStatus(dto.startAt, dto.endAt);
    if (isSlotStatus(status) && (await this.slotCount(storeId)) >= MAX_ACTIVE_STORE_SLIDES) throw new BadRequestException(SLOT_FULL_MESSAGE);
    if (!file) throw new BadRequestException('A banner image is required');

    validateCreativeDimensions(file, 'storeHero');
    const uploaded = await this.mediaLibraryService.uploadAndTrack(file, 'seller', sellerId, {
      folder: 'uploads/store-banners',
      maxDimension: HERO_MAX_DIMENSION,
    });

    if (uploaded.width && uploaded.width < HERO_MIN_SOURCE_WIDTH) {
      await cloudinary.uploader.destroy(uploaded.publicId).catch(() => {});
      throw new BadRequestException(
        `Image is only ${uploaded.width}px wide — this banner renders full-width on desktop, so please upload at least ${HERO_MIN_SOURCE_WIDTH}px wide (recommended: 2560×720) to avoid blur.`,
      );
    }

    let mobileUploaded: { url: string; publicId: string; width?: number } | null = null;
    if (mobileFile) {
      validateCreativeDimensions(mobileFile, 'mobile');
      mobileUploaded = await this.mediaLibraryService.uploadAndTrack(mobileFile, 'seller', sellerId, {
        folder: 'uploads/store-banners',
        maxDimension: MOBILE_HERO_MAX_DIMENSION,
      });

      if (mobileUploaded.width && mobileUploaded.width < MOBILE_HERO_MIN_SOURCE_WIDTH) {
        await cloudinary.uploader.destroy(mobileUploaded.publicId).catch(() => {});
        throw new BadRequestException(
          `Mobile image is only ${mobileUploaded.width}px wide — please upload at least ${MOBILE_HERO_MIN_SOURCE_WIDTH}px wide.`,
        );
      }
    }

    const currentCount = await this.storeBannerModel.countDocuments({ storeId });

    const banner = await this.storeBannerModel.create({
      storeId,
      type: dto.type ?? 'hero',
      imageUrl: uploaded.url,
      publicId: uploaded.publicId,
      mobileImageUrl: mobileUploaded?.url ?? null,
      mobilePublicId: mobileUploaded?.publicId ?? '',
      ctaLabel: dto.ctaLabel ?? null,
      linkType: link?.linkType ?? 'external',
      linkTarget: link?.linkTarget ?? null,
      order: dto.order ?? currentCount,
      priority: dto.priority ?? 0,
      status,
      startAt: dto.startAt ?? null,
      endAt: dto.endAt ?? null,
      createdBy: sellerId,
    });

    // Two requests at the same moment can both pass the count above: the newer one gives way.
    if (isSlotStatus(status) && !(await this.keepsSlot(storeId, String(banner._id)))) {
      await this.storeBannerModel.deleteOne({ _id: banner._id });
      for (const publicId of [uploaded.publicId, mobileUploaded?.publicId]) if (publicId) await cloudinary.uploader.destroy(publicId).catch(() => {});
      throw new BadRequestException(SLOT_FULL_MESSAGE);
    }

    this.log(storeId, 'store_banner_created', `Created a "${banner.type}" store banner`, sellerId, banner._id);
    return { success: true, message: 'Store banner created', data: banner };
  }

  private async findOwned(storeId: string, sellerId: string, bannerId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const banner = await this.storeBannerModel.findOne({ _id: bannerId, storeId });
    if (!banner) throw new NotFoundException('Store banner not found');
    return banner;
  }

  async update(storeId: string, sellerId: string, bannerId: string, dto: UpdateStoreBannerDto) {
    const current = await this.findOwned(storeId, sellerId, bannerId);

    // Explicit fields only. `{ ...dto }` went straight into $set, and the global ValidationPipe does not strip unknown
    // keys — a seller could PATCH status:"active" (skip the schedule), storeId (another store's carousel), imageUrl to
    // any URL, or publicId to ANOTHER tenant's asset id (which remove() then destroys on Cloudinary).
    const set: Record<string, unknown> = {};
    if (dto.type !== undefined) set.type = dto.type;
    if (dto.ctaLabel !== undefined) set.ctaLabel = dto.ctaLabel;
    if (dto.order !== undefined) set.order = dto.order;
    if (dto.priority !== undefined) set.priority = dto.priority;
    if (dto.startAt !== undefined) set.startAt = dto.startAt;
    if (dto.endAt !== undefined) set.endAt = dto.endAt;
    // The link is only re-validated when the request touches it (an old slide with a legacy link can still change its label).
    if (dto.linkType !== undefined || dto.linkTarget !== undefined) {
      const link = this.cleanLink(dto.linkType ?? current.linkType, dto.linkTarget ?? (dto.linkType !== undefined ? current.linkTarget : null));
      if (link) await this.assertOwnLiveLink(storeId, link);
      set.linkType = link?.linkType ?? 'external';
      set.linkTarget = link?.linkTarget ?? null;
    }
    let becomesSlot = false;
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      const status = computeInitialStatus(dto.startAt as string | undefined, dto.endAt as string | undefined);
      set.status = status;
      becomesSlot = isSlotStatus(status) && !isSlotStatus(current.status);
      if (becomesSlot && (await this.slotCount(storeId, bannerId)) >= MAX_ACTIVE_STORE_SLIDES) throw new BadRequestException(SLOT_FULL_MESSAGE);
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to update');

    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: set }, { returnDocument: 'after', runValidators: true });
    if (becomesSlot && !(await this.keepsSlot(storeId, bannerId))) {
      await this.storeBannerModel.updateOne({ _id: bannerId }, { $set: { status: current.status } });
      throw new BadRequestException(SLOT_FULL_MESSAGE);
    }
    this.log(storeId, 'store_banner_updated', 'Updated a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner updated', data: updated };
  }

  async pause(storeId: string, sellerId: string, bannerId: string) {
    await this.findOwned(storeId, sellerId, bannerId);
    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: { status: 'paused' } }, { returnDocument: 'after' });
    this.log(storeId, 'store_banner_paused', 'Paused a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner paused', data: updated };
  }

  async resume(storeId: string, sellerId: string, bannerId: string) {
    const banner = await this.findOwned(storeId, sellerId, bannerId);
    if (banner.endAt && banner.endAt.getTime() < Date.now()) {
      throw new BadRequestException('This banner already passed its end date — update endAt before resuming');
    }
    const wasSlot = isSlotStatus(banner.status);
    if (!wasSlot && (await this.slotCount(storeId, bannerId)) >= MAX_ACTIVE_STORE_SLIDES) throw new BadRequestException(SLOT_FULL_MESSAGE);
    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: { status: 'active' } }, { returnDocument: 'after' });
    if (!wasSlot && !(await this.keepsSlot(storeId, bannerId))) {
      await this.storeBannerModel.updateOne({ _id: bannerId }, { $set: { status: banner.status } });
      throw new BadRequestException(SLOT_FULL_MESSAGE);
    }
    this.log(storeId, 'store_banner_resumed', 'Resumed a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner resumed', data: updated };
  }

  /** Sets the slide order. `ids` must be exactly this store's banners (own store only). Order = position in the list. */
  async reorder(storeId: string, sellerId: string, ids: unknown) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const all = await this.storeBannerModel.find({ storeId }).select('_id').lean();
    const list = validateReorderIds(ids, all.map((b: any) => String(b._id)), (m) => { throw new BadRequestException(m); });
    // priority is reset too: the public order is priority (desc) first, which would otherwise override the new order.
    await this.storeBannerModel.bulkWrite(list.map((id, i) => ({ updateOne: { filter: { _id: id, storeId }, update: { $set: { order: i, priority: 0 } } } })));
    this.log(storeId, 'store_banner_reordered', 'Reordered store banners', sellerId, storeId);
    return { success: true, message: 'Store banners reordered' };
  }

  async remove(storeId: string, sellerId: string, bannerId: string) {
    const banner = await this.findOwned(storeId, sellerId, bannerId);

    for (const publicId of [banner.publicId, banner.mobilePublicId]) {
      if (!publicId) continue;
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        console.warn('Could not delete from Cloudinary:', err.message);
      }
    }

    await this.storeBannerModel.deleteOne({ _id: bannerId });
    this.log(storeId, 'store_banner_deleted', 'Deleted a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner deleted' };
  }

  async timeline(storeId: string, sellerId: string, bannerId: string) {
    await this.findOwned(storeId, sellerId, bannerId);
    return this.activityLogService.getTimeline(bannerId);
  }
}
