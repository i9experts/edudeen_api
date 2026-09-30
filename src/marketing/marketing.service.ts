/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ActiveCampaignForStore } from './campaign-pricing.util';
import { generateUniqueSlug } from 'src/common/slug.util';

@Injectable()
export class MarketingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  async createCoupon(sellerId: string, storeId: string, dto: CreateCouponDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const code = dto.code.trim().toUpperCase();
    const existing = await this.r.couponModel.findOne({ storeId, code, isDelete: false });
    if (existing) throw new ConflictException(`Coupon code "${code}" already exists for this store`);

    if (dto.discountType === 'percentage' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    const coupon = await this.r.couponModel.create({
      storeId,
      sellerId,
      code,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      minOrderAmount: dto.minOrderAmount ?? null,
      usageLimit: dto.usageLimit ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const discountLabel = dto.discountType === 'percentage' ? `${dto.discountValue}% off` : `$${dto.discountValue} off`;
    const expiryLabel = coupon.expiresAt ? ` — expires ${coupon.expiresAt.toLocaleDateString()}` : '';

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'coupon_created',
      description: `${code} — ${discountLabel}${expiryLabel}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: String(coupon._id),
      targetType: 'coupon',
      ip,
      userAgent,
    });

    return { success: true, message: 'Coupon created', data: coupon };
  }

  async getCoupons(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

    const total = await this.r.couponModel.countDocuments(filter);
    const coupons = await this.r.couponModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    return { success: true, data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, coupons } };
  }

  async updateCoupon(sellerId: string, storeId: string, couponId: string, dto: UpdateCouponDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const coupon = await this.r.couponModel.findOne({ _id: couponId, storeId, isDelete: false });
    if (!coupon) throw new NotFoundException('Coupon not found');

    const update: any = {};
    if (dto.code !== undefined) update.code = dto.code.trim().toUpperCase();
    if (dto.discountType !== undefined) update.discountType = dto.discountType;
    if (dto.discountValue !== undefined) update.discountValue = dto.discountValue;
    if (dto.minOrderAmount !== undefined) update.minOrderAmount = dto.minOrderAmount;
    if (dto.usageLimit !== undefined) update.usageLimit = dto.usageLimit;
    if (dto.expiresAt !== undefined) update.expiresAt = new Date(dto.expiresAt);
    if (dto.isActive !== undefined) update.isActive = dto.isActive;

    const updated = await this.r.couponModel.findByIdAndUpdate(couponId, update, { returnDocument: 'after' });

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: dto.isActive === false ? 'coupon_deactivated' : 'coupon_updated',
      description: `${(updated as any).code} updated`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: couponId,
      targetType: 'coupon',
      ip,
      userAgent,
    });

    return { success: true, message: 'Coupon updated', data: updated };
  }

  async deleteCoupon(sellerId: string, storeId: string, couponId: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const coupon = await this.r.couponModel.findOne({ _id: couponId, storeId, isDelete: false });
    if (!coupon) throw new NotFoundException('Coupon not found');

    await this.r.couponModel.findByIdAndUpdate(couponId, { isDelete: true, isActive: false });

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'coupon_deleted',
      description: `${coupon.code} deleted`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: couponId,
      targetType: 'coupon',
      ip,
      userAgent,
    });

    return { success: true, message: 'Coupon deleted' };
  }

  // ─── Platform-wide sale campaigns (admin-created, seller opt-in) ────────

  async getJoinableCampaigns(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const now = new Date();
    const campaigns = await this.r.campaignModel
      .find({ isDelete: false, status: 'active', endDate: { $gte: now } })
      .sort({ startDate: 1 })
      .lean();

    const data = campaigns.map((c) => ({
      ...c,
      isJoined: c.sponsorType === 'platform' ? true : (c.participatingStoreIds ?? []).includes(storeId),
    }));
    return { success: true, data };
  }

  async joinCampaign(sellerId: string, storeId: string, campaignId: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const campaign = await this.r.campaignModel.findOne({ _id: campaignId, isDelete: false, status: 'active' });
    if (!campaign) throw new NotFoundException('Campaign not found or not active');
    if (campaign.sponsorType === 'platform') {
      throw new BadRequestException('This is a platform-sponsored campaign — every store is automatically included, there\'s nothing to join.');
    }

    if (!campaign.participatingStoreIds.includes(storeId)) {
      await this.r.campaignModel.findByIdAndUpdate(campaignId, { $addToSet: { participatingStoreIds: storeId } });
    }

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'campaign_joined',
      description: `Joined platform campaign "${campaign.name}"`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: campaignId,
      targetType: 'campaign',
      ip,
      userAgent,
    });

    return { success: true, message: 'Joined campaign' };
  }

  async leaveCampaign(sellerId: string, storeId: string, campaignId: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const campaign = await this.r.campaignModel.findOne({ _id: campaignId, isDelete: false });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.sponsorType === 'platform') {
      throw new BadRequestException('This is a platform-sponsored campaign — every store is automatically included and can\'t opt out individually.');
    }

    await this.r.campaignModel.findByIdAndUpdate(campaignId, { $pull: { participatingStoreIds: storeId } });

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'campaign_left',
      description: `Left platform campaign "${campaign.name}"`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: campaignId,
      targetType: 'campaign',
      ip,
      userAgent,
    });

    return { success: true, message: 'Left campaign' };
  }

  // ─── Shared "is this store on sale right now" lookup ────────────────────
  // The single source of truth for what counts as an active campaign for a
  // store — checkout pricing (CheckoutService), marketplace/product badges
  // (ProductsService) and the store page (StoreService) all resolve through
  // this one query instead of each re-deriving the status+date-window rule.
  //
  // sponsorType: 'platform' campaigns apply to EVERY store unconditionally —
  // participatingStoreIds is meaningless for them (there's nothing for a
  // seller to opt into when the platform is footing the bill, and a new store
  // created mid-campaign must be included without any extra enrollment step).
  // sponsorType: 'seller' campaigns still only apply to stores whose seller
  // explicitly joined, via participatingStoreIds, exactly as before.
  /** One query for any number of stores — callers doing this per-listing-page
   *  (marketplace, store products) must call it once for the whole page of
   *  storeIds, never per-product, to keep it O(1) queries regardless of
   *  result-set size. */
  async getActiveCampaignsForStores(storeIds: string[]): Promise<Map<string, ActiveCampaignForStore[]>> {
    const map = new Map<string, ActiveCampaignForStore[]>();
    if (storeIds.length === 0) return map;

    const uniqueIds = [...new Set(storeIds)];
    const now = new Date();
    const campaigns = await this.r.campaignModel
      .find({
        isDelete: false,
        status: 'active',
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [
          { sponsorType: 'platform' },
          { participatingStoreIds: { $in: uniqueIds } },
        ],
      })
      .select('name endDate discountType discountValue currency participatingStoreIds sponsorType')
      .lean();

    for (const c of campaigns) {
      const summary: ActiveCampaignForStore = {
        campaignId: String(c._id),
        name: c.name,
        discountType: c.discountType ?? null,
        discountValue: c.discountValue ?? null,
        currency: c.currency ?? 'USD',
        endDate: c.endDate,
        sponsorType: c.sponsorType ?? 'seller',
      };
      const applicableStoreIds = summary.sponsorType === 'platform'
        ? uniqueIds
        : (c.participatingStoreIds ?? []).filter((id) => uniqueIds.includes(id));
      for (const storeId of applicableStoreIds) {
        const existing = map.get(storeId);
        if (existing) existing.push(summary);
        else map.set(storeId, [summary]);
      }
    }
    return map;
  }

  async getActiveCampaignsForStore(storeId: string): Promise<ActiveCampaignForStore[]> {
    const map = await this.getActiveCampaignsForStores([storeId]);
    return map.get(storeId) ?? [];
  }

  // ─── Public consumption (buyer marketplace/homepage banner) ────────────
  // `storeType` (a Store.productTypes value, e.g. 'educational_resources')
  // scopes seller-sponsored campaigns to only those with at least one
  // participating store of that type — used by EducationMarketplace so a
  // physical/digital-only seller's campaign never shows there. Platform-
  // sponsored campaigns are unaffected: they apply store-wide regardless.
  async getPublicActiveCampaigns(storeType?: string) {
    const now = new Date();

    let eligibleStoreIds: string[] | null = null;
    if (storeType) {
      const stores = await this.r.storeModel
        .find({ productTypes: storeType, isDelete: false, status: 'active' }, '_id')
        .lean();
      eligibleStoreIds = stores.map((s) => String(s._id));
    }

    const campaigns = await this.r.campaignModel
      .find({
        isDelete: false,
        status: 'active',
        startDate: { $lte: now },
        endDate: { $gte: now },
        // A seller-sponsored campaign with no participating stores discounts
        // nothing — showing it as a live "Up to X% off" banner with a real
        // countdown would be advertising a sale that doesn't actually exist
        // yet. Platform-sponsored campaigns skip this check entirely: they
        // apply to every store the moment they're active, regardless of
        // participatingStoreIds (see getActiveCampaignsForStores).
        $or: [
          { sponsorType: 'platform' },
          eligibleStoreIds
            ? { participatingStoreIds: { $in: eligibleStoreIds } }
            : { 'participatingStoreIds.0': { $exists: true } },
        ],
      })
      // Admin-controlled rotation order first (see Campaign.order), soonest-
      // ending as the tiebreaker for campaigns left at their default order.
      .sort({ order: 1, endDate: 1 })
      .lean();

    // Only computed if actually needed — a "how many stores" count is
    // meaningless for participatingStoreIds on a platform-sponsored campaign,
    // it's every active store instead.
    const hasPlatformSponsored = campaigns.some((c) => c.sponsorType === 'platform');
    const activeStoreCount = hasPlatformSponsored
      ? await this.r.storeModel.countDocuments({ isDelete: false, status: 'active' })
      : 0;

    const data: any[] = [];
    for (const c of campaigns) {
      // Pre-migration campaigns created before the slug field existed —
      // backfill once, persisted, same self-healing approach as Category.
      let slug = c.slug;
      if (!slug) {
        slug = await generateUniqueSlug(this.r.campaignModel, c.name, { excludeId: String(c._id) });
        await this.r.campaignModel.findByIdAndUpdate(c._id, { slug });
      }
      data.push({
        _id: c._id,
        slug,
        name: c.name,
        description: c.description,
        bannerImage: c.bannerImage,
        endDate: c.endDate,
        discountType: c.discountType,
        discountValue: c.discountValue,
        currency: c.currency ?? 'USD',
        sponsorType: c.sponsorType ?? 'seller',
        storeCount: c.sponsorType === 'platform' ? activeStoreCount : (c.participatingStoreIds ?? []).length,
      });
    }
    return { success: true, data };
  }
}
