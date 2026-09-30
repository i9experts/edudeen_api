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
    const limit = await this.adminConfigService.getPlacementLimit('storeHero');
    const banners = await this.storeBannerModel
      .find({ storeId, status: 'active' })
      .sort({ priority: -1, order: 1 })
      .limit(limit)
      .lean();
    return { success: true, count: banners.length, data: banners };
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
    this.assertLink(dto.linkType, dto.linkTarget); // before the upload, so a bad link leaves no orphan asset
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

    const status = computeInitialStatus(dto.startAt, dto.endAt);
    const currentCount = await this.storeBannerModel.countDocuments({ storeId });

    const banner = await this.storeBannerModel.create({
      storeId,
      type: dto.type ?? 'hero',
      imageUrl: uploaded.url,
      publicId: uploaded.publicId,
      mobileImageUrl: mobileUploaded?.url ?? null,
      mobilePublicId: mobileUploaded?.publicId ?? '',
      ctaLabel: dto.ctaLabel ?? null,
      linkType: dto.linkType ?? 'external',
      linkTarget: dto.linkTarget ?? null,
      order: dto.order ?? currentCount,
      priority: dto.priority ?? 0,
      status,
      startAt: dto.startAt ?? null,
      endAt: dto.endAt ?? null,
      createdBy: sellerId,
    });

    this.log(storeId, 'store_banner_created', `Created a "${banner.type}" store banner`, sellerId, banner._id);
    return { success: true, message: 'Store banner created', data: banner };
  }

  private async findOwned(storeId: string, sellerId: string, bannerId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const banner = await this.storeBannerModel.findOne({ _id: bannerId, storeId });
    if (!banner) throw new NotFoundException('Store banner not found');
    return banner;
  }

  /** A banner link is served publicly and followed by buyers: an external one must be https, an internal one an id. */
  private assertLink(linkType: string | undefined, linkTarget: string | null | undefined) {
    if (linkTarget === undefined || linkTarget === null || linkTarget === '') return;
    if (typeof linkTarget !== 'string' || linkTarget.length > 2048) throw new BadRequestException('linkTarget is too long');
    if ((linkType ?? 'external') === 'external') {
      if (!/^https:\/\/\S+$/i.test(linkTarget)) throw new BadRequestException('An external banner link must be an https URL');
    } else if (!/^[a-f0-9]{24}$/i.test(linkTarget)) {
      throw new BadRequestException('An internal banner link must be a product / category / collection id');
    }
  }

  async update(storeId: string, sellerId: string, bannerId: string, dto: UpdateStoreBannerDto) {
    const current = await this.findOwned(storeId, sellerId, bannerId);

    // Explicit fields only. `{ ...dto }` went straight into $set, and the global ValidationPipe does not strip unknown
    // keys — a seller could PATCH status:"active" (skip the schedule), storeId (another store's carousel), imageUrl to
    // any URL, or publicId to ANOTHER tenant's asset id (which remove() then destroys on Cloudinary).
    const set: Record<string, unknown> = {};
    if (dto.type !== undefined) set.type = dto.type;
    if (dto.ctaLabel !== undefined) set.ctaLabel = dto.ctaLabel;
    if (dto.linkType !== undefined) set.linkType = dto.linkType;
    if (dto.linkTarget !== undefined) set.linkTarget = dto.linkTarget;
    if (dto.order !== undefined) set.order = dto.order;
    if (dto.priority !== undefined) set.priority = dto.priority;
    if (dto.startAt !== undefined) set.startAt = dto.startAt;
    if (dto.endAt !== undefined) set.endAt = dto.endAt;
    this.assertLink((set.linkType as string | undefined) ?? current.linkType, (set.linkTarget as string | undefined) ?? current.linkTarget);
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      set.status = computeInitialStatus(dto.startAt as string | undefined, dto.endAt as string | undefined);
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to update');

    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: set }, { returnDocument: 'after', runValidators: true });
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
    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: { status: 'active' } }, { returnDocument: 'after' });
    this.log(storeId, 'store_banner_resumed', 'Resumed a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner resumed', data: updated };
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
