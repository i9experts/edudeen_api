/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { DatabaseService } from 'src/database/databaseservice';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { MediaLibraryService } from '../media-library/media-library.service';
import { validateCreativeDimensions } from '../common/validate-creative-dimensions.util';
import { BannerStatus } from './schemas/banner.schema';
import { PromotionPlacement } from '../common/promotion-placements.const';

const DEFAULT_PLACEMENT: PromotionPlacement = 'marketplaceHero';

// Master stored well above any real viewport (incl. retina/4K) — the frontend
// never fetches this directly, it requests per-breakpoint Cloudinary
// derivatives (see cloudinaryImage.ts), so a generous master costs nothing in
// visitor bandwidth, only Cloudinary storage.
const HERO_MAX_DIMENSION = 2560;
// Below this, even the full-bleed desktop render (which needs up to
// HERO_MAX_DIMENSION-wide sources on retina/4K) would visibly upscale —
// reject rather than silently store a source that will always look soft.
const HERO_MIN_SOURCE_WIDTH = 1280;

/** A row is "visible" whether it was migrated to the new `status` field or is a
 * pre-migration legacy row that only ever had `isActive`. */
const VISIBLE_FILTER = { $or: [{ status: 'active' }, { status: { $exists: false }, isActive: true }] };

/** Matches both the new multi-placement `placements` array and the legacy
 * scalar `placement` field (pre-migration rows have an empty `placements`
 * array and rely entirely on the scalar field). Wrapped in its own `$or` key
 * so callers must combine it via `$and` — `VISIBLE_FILTER` already owns the
 * top-level `$or` key, and a second `$or` at the same level would silently
 * overwrite it instead of combining. */
function placementMatch(placement: PromotionPlacement) {
  return { $or: [{ placements: placement }, { placement }] };
}

function computeInitialStatus(startAt?: string, endAt?: string): BannerStatus {
  if (endAt && new Date(endAt).getTime() < Date.now()) {
    throw new BadRequestException('endAt is in the past');
  }
  if (startAt && new Date(startAt).getTime() > Date.now()) return 'scheduled';
  return 'active';
}

@Injectable()
export class BannersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
    private readonly mediaLibraryService: MediaLibraryService,
  ) {}

  private get bannerModel() {
    return this.databaseService.repositories.bannerModel;
  }

  // ── GET ALL (public) ───────────────────────────────────────────────────────
  // No `placement` filter is applied unless the caller passes one — this keeps
  // every existing consumer's behavior (unscoped, all active banners) identical
  // post-migration. Placement-aware pages opt in explicitly.

  async findAll(placement?: PromotionPlacement) {
    const filter: Record<string, unknown> = { ...VISIBLE_FILTER };
    if (placement) filter.$and = [placementMatch(placement)];

    let query = this.bannerModel.find(filter).sort({ order: 1, createdAt: 1 });
    if (placement) {
      const limit = await this.adminConfigService.getPlacementLimit(placement);
      query = query.limit(limit);
    }
    const banners = await query.lean();

    return { success: true, count: banners.length, data: banners };
  }

  // ── GET COUNT (admin) ──────────────────────────────────────────────────────

  async getCount(placement: PromotionPlacement = DEFAULT_PLACEMENT) {
    const count = await this.bannerModel.countDocuments({ ...VISIBLE_FILTER, $and: [placementMatch(placement)] });
    const max = await this.adminConfigService.getPlacementLimit(placement);

    return {
      success: true,
      data: { placement, current: count, visibleLimit: max, isOversubscribed: count > max },
    };
  }

  // ── CREATE FROM URL (admin) ────────────────────────────────────────────────

  async createFromUrl(dto: CreateBannerDto) {
    if (!dto.bannerImage) throw new BadRequestException('bannerImage URL is required');

    const placements = dto.placements?.length ? dto.placements : [dto.placement ?? DEFAULT_PLACEMENT];
    const placement = placements[0];
    const status = computeInitialStatus(dto.startAt, dto.endAt);

    // Re-host through Cloudinary rather than trusting the pasted URL as-is —
    // an admin can paste any external image (e.g. a search-result thumbnail),
    // and without this there's no way to know its real pixel dimensions, no
    // shared max-dimension cap, and the frontend's responsive srcset helper
    // can't transform a non-Cloudinary URL at all (it no-ops for those).
    let hosted: { secure_url: string; public_id: string; width?: number };
    try {
      hosted = await cloudinary.uploader.upload(dto.bannerImage, {
        folder: 'uploads/spotlight',
        resource_type: 'image',
        transformation: [{ width: HERO_MAX_DIMENSION, height: HERO_MAX_DIMENSION, crop: 'limit' }],
      });
    } catch (err) {
      throw new BadRequestException(`Could not fetch that image URL: ${err.message || 'unknown error'}`);
    }

    if (hosted.width && hosted.width < HERO_MIN_SOURCE_WIDTH) {
      await cloudinary.uploader.destroy(hosted.public_id).catch(() => {});
      throw new BadRequestException(
        `That image is only ${hosted.width}px wide — this banner renders full-width on desktop, so please use an image at least ${HERO_MIN_SOURCE_WIDTH}px wide (recommended: 2560×720) to avoid blur.`,
      );
    }

    const currentCount = await this.bannerModel.countDocuments({ $and: [placementMatch(placement)] });

    const banner = await this.bannerModel.create({
      bannerImage: hosted.secure_url,
      publicId: hosted.public_id,
      urlOnTap: dto.urlOnTap || null,
      order: dto.order ?? currentCount,
      placement,
      placements,
      status,
      isActive: status === 'active',
      startAt: dto.startAt ?? null,
      endAt: dto.endAt ?? null,
    });

    return { success: true, message: 'Banner created successfully', data: banner };
  }

  // ── UPLOAD FILE (admin) ─────────────────────────────────────────────────────
  // Routed through MediaLibraryService (-> the shared UploadService) instead of
  // the CloudinaryStorage-multer path this used to have — one upload code path,
  // and the creative is now tracked for reuse via the media picker.

  async uploadBanner(file: Express.Multer.File, adminId: string, urlOnTap?: string, placementInput?: string) {
    if (!file) throw new BadRequestException('No image file provided');

    const placement = (placementInput as PromotionPlacement) ?? DEFAULT_PLACEMENT;
    validateCreativeDimensions(file, placement);

    const uploaded = await this.mediaLibraryService.uploadAndTrack(file, 'admin', adminId, {
      folder: 'uploads/spotlight',
      maxDimension: HERO_MAX_DIMENSION,
    });

    if (uploaded.width && uploaded.width < HERO_MIN_SOURCE_WIDTH) {
      await cloudinary.uploader.destroy(uploaded.publicId).catch(() => {});
      throw new BadRequestException(
        `Image is only ${uploaded.width}px wide — this banner renders full-width on desktop, so please upload at least ${HERO_MIN_SOURCE_WIDTH}px wide (recommended: 2560×720) to avoid blur.`,
      );
    }

    const currentCount = await this.bannerModel.countDocuments({ placement });

    const banner = await this.bannerModel.create({
      bannerImage: uploaded.url,
      publicId: uploaded.publicId,
      urlOnTap: urlOnTap || null,
      order: currentCount,
      placement,
      status: 'active',
      isActive: true,
    });

    return { success: true, message: 'Banner uploaded successfully', data: banner };
  }

  // ── EDIT BANNER (admin) ────────────────────────────────────────────────────

  async updateBanner(bannerId: string, dto: UpdateBannerDto) {
    const banner = await this.bannerModel.findById(bannerId);
    if (!banner) throw new NotFoundException('Banner not found');

    const set: Record<string, unknown> = { ...dto };
    // Keep the legacy scalar `placement` in sync as `placements[0]` whenever
    // the multi-select array is what actually changed.
    if (dto.placements?.length) {
      set.placements = dto.placements;
      set.placement = dto.placements[0];
    }
    // Keep `isActive` in sync for any code still reading it directly, whenever
    // this write changes the schedule (status itself is set explicitly via
    // pause/resume, not through this generic update).
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      const status = computeInitialStatus(dto.startAt as string | undefined, dto.endAt as string | undefined);
      set.status = status;
      set.isActive = status === 'active';
    }

    const updated = await this.bannerModel.findByIdAndUpdate(bannerId, { $set: set }, { returnDocument: 'after', runValidators: true });
    return { success: true, message: 'Banner updated successfully', data: updated };
  }

  // ── PAUSE / RESUME (admin) — status toggle only, never shifts endAt ────────

  async pauseBanner(bannerId: string) {
    const banner = await this.bannerModel.findById(bannerId);
    if (!banner) throw new NotFoundException('Banner not found');
    const updated = await this.bannerModel.findByIdAndUpdate(
      bannerId,
      { $set: { status: 'paused', isActive: false } },
      { returnDocument: 'after' },
    );
    return { success: true, message: 'Banner paused', data: updated };
  }

  async resumeBanner(bannerId: string) {
    const banner = await this.bannerModel.findById(bannerId);
    if (!banner) throw new NotFoundException('Banner not found');
    if (banner.endAt && banner.endAt.getTime() < Date.now()) {
      throw new BadRequestException('This banner already passed its end date — update endAt before resuming');
    }
    const updated = await this.bannerModel.findByIdAndUpdate(
      bannerId,
      { $set: { status: 'active', isActive: true } },
      { returnDocument: 'after' },
    );
    return { success: true, message: 'Banner resumed', data: updated };
  }

  // ── DELETE BANNER (admin) ──────────────────────────────────────────────────

  async deleteBanner(bannerId: string) {
    const banner = await this.bannerModel.findById(bannerId);
    if (!banner) throw new NotFoundException('Banner not found');

    if (banner.publicId) {
      try {
        await cloudinary.uploader.destroy(banner.publicId);
      } catch (err) {
        console.warn('Could not delete from Cloudinary:', err.message);
      }
    }

    await this.bannerModel.deleteOne({ _id: bannerId });
    return { success: true, message: 'Banner deleted successfully' };
  }
}
