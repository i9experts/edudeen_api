/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { UpdateCampaignStatusDto } from './dto/update-campaign-status.dto';
import { CreatePlatformCouponDto } from './dto/create-platform-coupon.dto';
import { UpdatePlatformCouponDto } from './dto/update-platform-coupon.dto';
import { generateUniqueSlug } from '../common/slug.util';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminMarketingService {
  private readonly logger = new Logger(AdminMarketingService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /** The seller's own sale (automatic discounts, bundles, or a compare-at price on a product) was hidden while the
   *  campaign ran. Now that it ended it shows again, so each store that HAS such a sale gets a notification asking
   *  whether to continue it. Once per campaign (endNotifiedAt); background, never blocks the expiry job. */
  private announceCampaignEnded(campaign: { _id: unknown; name: string; sponsorType?: string; participatingStoreIds?: string[]; endNotifiedAt?: Date | null; discountType?: string | null; discountValue?: number | null; startDate?: Date }) {
    if (!this.notificationsService || campaign.endNotifiedAt) return;
    // A badge-only campaign (no discount) or one that never started never hid anyone's own sale.
    if (!campaign.discountType || campaign.discountValue == null) return;
    if (campaign.startDate && new Date(campaign.startDate) > new Date()) return;
    const notifications = this.notificationsService;
    void (async () => {
      try {
        // Claim first so overlapping runs never notify twice.
        const claimed = await this.r.campaignModel.updateOne({ _id: campaign._id as any, endNotifiedAt: null }, { $set: { endNotifiedAt: new Date() } });
        if (!claimed.modifiedCount) return;
        const candidateFilter: Record<string, unknown> = { status: 'active', isDelete: false };
        if (campaign.sponsorType !== 'platform') candidateFilter._id = { $in: campaign.participatingStoreIds ?? [] };
        const stores = await this.r.storeModel.find(candidateFilter).select('_id sellerId name').lean();
        const ids = (stores as any[]).map((s) => String(s._id));
        if (ids.length === 0) return;
        const cid = String(campaign._id);
        const [autos, bundles, markdownVariants] = await Promise.all([
          this.r.automaticDiscountModel.distinct('storeId', { storeId: { $in: ids }, isActive: true, isDelete: false }),
          this.r.bundleModel.distinct('storeId', { storeId: { $in: ids }, isActive: true, isDelete: false }),
          this.r.productVariantModel.find({ compareAtPrice: { $gt: 0 }, isDelete: false }).select('productId price compareAtPrice').limit(20000).lean(),
        ]);
        const markdownProductIds = (markdownVariants as any[]).filter((v) => v.compareAtPrice > v.price).map((v) => v.productId);
        const markdownProducts = markdownProductIds.length
          ? await this.r.productModel.find({ _id: { $in: markdownProductIds }, storeId: { $in: ids }, isDelete: false }).select('storeId campaignIds').lean()
          : [];
        // a markdown only counts when its product was in the campaign (the seller ticked it - strict opt-in)
        const markdownStores = (markdownProducts as any[])
          .filter((p) => (p.campaignIds ?? []).includes(cid))
          .map((p) => p.storeId);
        const withOwnSale = new Set<string>([...autos, ...bundles, ...markdownStores].map(String));
        const BATCH = 25;
        const targets = (stores as any[]).filter((s) => withOwnSale.has(String(s._id)));
        for (let i = 0; i < targets.length; i += BATCH) {
          await Promise.all(targets.slice(i, i + BATCH).map((s: any) => notifications.notify({
            recipientId: String(s.sellerId),
            recipientRole: 'seller',
            type: NOTIFICATION_TYPES.PLATFORM_CAMPAIGN_LIVE,
            title: `${campaign.name} has ended — your own sale is showing again`,
            body: 'Your own discounts and sale prices on the products that were in this campaign were hidden while it ran. They are visible again now. Do you want to continue your sale? Open Marketing to keep, change or end it.',
            data: { campaignId: String(campaign._id), storeId: String(s._id), link: `/store/${String(s._id)}/marketing?tab=discounts` },
          })));
        }
      } catch (err: any) {
        this.logger.error(`announceCampaignEnded failed: ${err?.message}`);
      }
    })();
  }

  /** Tells every seller with an active store that a sale campaign just went
   *  live, so they can join it (seller-sponsored) or know their products are
   *  already discounted (platform-sponsored). Runs in the background — the
   *  admin's request never waits on hundreds of notifications. */
  private announceCampaignLive(campaign: { _id: unknown; name: string; sponsorType?: string; discountType?: string | null; discountValue?: number | null; startDate: Date; endDate: Date }) {
    if (!this.notificationsService) return;
    const notifications = this.notificationsService;
    void (async () => {
      try {
        const stores = await this.r.storeModel
          .find({ status: 'active', isDelete: false })
          .select('_id sellerId')
          .lean();
        const off = campaign.discountValue
          ? campaign.discountType === 'percentage' ? `${campaign.discountValue}% off` : `$${campaign.discountValue} off`
          : null;
        const isPlatform = campaign.sponsorType === 'platform';
        const start = new Date(campaign.startDate);
        const title = start > new Date()
          ? `${campaign.name} starts ${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
          : `${campaign.name} is live`;
        const body = isPlatform
          ? `${off ? `${off} — ` : ''}your products are already included and Edudeen covers the discount.`
          : `${off ? `${off} — ` : ''}join from Marketing → Platform Sales to put your products in the sale.`;
        const BATCH = 25;
        for (let i = 0; i < stores.length; i += BATCH) {
          await Promise.all(stores.slice(i, i + BATCH).map((s: any) => notifications.notify({
            recipientId: String(s.sellerId),
            recipientRole: 'seller',
            type: NOTIFICATION_TYPES.PLATFORM_CAMPAIGN_LIVE,
            title,
            body,
            data: { campaignId: String(campaign._id), storeId: String(s._id), link: `/store/${String(s._id)}/marketing?tab=platform` },
          })));
        }
      } catch (err: any) {
        this.logger.error(`announceCampaignLive failed: ${err?.message}`);
      }
    })();
  }

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'marketing',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ─── Campaigns ───────────────────────────────────────────────────────────

  /** Two campaigns can never share a rotation position — whichever one holds
   *  a number keeps it exclusively, so a second campaign trying to claim the
   *  same slot is rejected with the name of who's already there, rather than
   *  silently creating an ambiguous tie in the deals-banner rotation order. */
  private async assertOrderAvailable(order: number | undefined, excludeId?: string) {
    if (order == null) return;
    // Ended campaigns no longer hold a rotation slot (expireCampaigns resets them to 0), so they must not block it.
    const filter: Record<string, unknown> = { isDelete: false, status: { $ne: 'ended' }, order };
    if (excludeId) filter._id = { $ne: excludeId };
    const conflict = await this.r.campaignModel.findOne(filter).select('name').lean();
    if (conflict) {
      throw new ConflictException(`Position ${order} is already used by "${conflict.name}" — choose a different number.`);
    }
  }

  async createCampaign(dto: CreateCampaignDto, meta: AuditMeta) {
    if (new Date(dto.endDate) <= new Date(dto.startDate)) {
      throw new BadRequestException('endDate must be after startDate');
    }
    if (dto.discountType === 'percentage' && dto.discountValue != null && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }
    await this.assertOrderAvailable(dto.order);

    // Defaults to "appended last" in the rotation, same convention as
    // Banner.order, unless the admin explicitly set a position.
    const currentCount = dto.order == null ? await this.r.campaignModel.countDocuments({ isDelete: false }) : 0;
    const slug = await generateUniqueSlug(this.r.campaignModel, dto.name);

    const campaign = await this.r.campaignModel.create({
      name: dto.name,
      slug,
      description: dto.description ?? null,
      bannerImage: dto.bannerImage ?? null,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
      discountType: dto.discountType ?? null,
      discountValue: dto.discountValue ?? null,
      sponsorType: dto.sponsorType ?? 'seller',
      order: dto.order ?? currentCount,
      createdBy: meta.adminId,
    });

    this.log('campaign_created', `Campaign "${dto.name}" created`, meta, String(campaign._id));
    return { success: true, message: 'Campaign created', data: campaign };
  }

  async listCampaigns(status?: string) {
    // Self-healing read: expiring here (not just via the scheduled cron)
    // means the admin list is never stale — a campaign whose endDate just
    // passed a second ago shows as 'ended' with its order slot already
    // freed the moment this page is loaded/refreshed, not up to 5 minutes
    // later. The cron (SchedulerService.expireCampaigns) stays as a backstop
    // for campaigns nobody happens to be viewing right now.
    await this.expireCampaigns();

    if (status !== undefined && !['draft', 'active', 'ended'].includes(status)) {
      throw new BadRequestException('status must be one of draft, active, ended');
    }
    const filter: Record<string, unknown> = { isDelete: false };
    if (status) filter.status = status;
    const campaigns = await this.r.campaignModel.find(filter).sort({ createdAt: -1 }).limit(500);
    return { success: true, data: campaigns };
  }

  private async findCampaignOrThrow(id: string) {
    const campaign = await this.r.campaignModel.findOne({ _id: id, isDelete: false });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async updateCampaign(id: string, dto: UpdateCampaignDto, meta: AuditMeta) {
    const existing = await this.findCampaignOrThrow(id);
    const effectiveType = dto.discountType !== undefined ? dto.discountType : existing.discountType;
    const effectiveValue = dto.discountValue !== undefined ? dto.discountValue : existing.discountValue;
    if (effectiveType === 'percentage' && effectiveValue != null && effectiveValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }
    if (
      (dto.startDate !== undefined || dto.endDate !== undefined) &&
      new Date(dto.endDate ?? existing.endDate) <= new Date(dto.startDate ?? existing.startDate)
    ) {
      throw new BadRequestException('endDate must be after startDate');
    }
    if (dto.order !== undefined && dto.order !== existing.order) {
      await this.assertOrderAvailable(dto.order, id);
    }
    // A status change in the same request is validated up front too, so the whole edit is applied or none of it.
    const statusChange = dto.status !== undefined && dto.status !== existing.status ? dto.status : undefined;
    if (statusChange === 'active') {
      if (new Date(dto.endDate ?? existing.endDate) <= new Date()) {
        throw new BadRequestException('This campaign has already ended — extend its end date before activating it');
      }
      const effectiveOrder = dto.order !== undefined ? dto.order : existing.order;
      if (effectiveOrder != null) await this.assertOrderAvailable(effectiveOrder, id);
    }

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined || key === 'status') continue;
      update[key] = key === 'startDate' || key === 'endDate' ? new Date(value as string) : value;
    }
    if (statusChange) {
      update.status = statusChange;
      if (statusChange === 'ended') update.order = 0;
    }
    const campaign = await this.r.campaignModel.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
    this.log('campaign_updated', `Campaign "${campaign!.name}" updated`, meta, id);
    if (statusChange === 'active') this.announceCampaignLive(campaign as any);
    if (statusChange === 'ended' && existing.status === 'active') this.announceCampaignEnded(campaign as any);
    return { success: true, message: 'Campaign updated', data: campaign };
  }

  async setCampaignStatus(id: string, dto: UpdateCampaignStatusDto, meta: AuditMeta) {
    const campaign = await this.findCampaignOrThrow(id);
    if (dto.status === 'active' && new Date(campaign.endDate) <= new Date()) {
      throw new BadRequestException('This campaign has already ended — extend its endDate before activating it');
    }
    if (dto.status === 'active' && campaign.order != null && campaign.status !== 'active') {
      await this.assertOrderAvailable(campaign.order, id);
    }
    await this.r.campaignModel.findByIdAndUpdate(id, { $set: dto.status === 'ended' ? { status: 'ended', order: 0 } : { status: dto.status } });
    this.log('campaign_status_changed', `Campaign "${campaign.name}" set to ${dto.status}`, meta, id);
    if (dto.status === 'active' && campaign.status !== 'active') this.announceCampaignLive(campaign as any);
    if (dto.status === 'ended' && campaign.status === 'active') this.announceCampaignEnded(campaign as any);
    return { success: true, message: `Campaign set to ${dto.status}` };
  }

  async deleteCampaign(id: string, meta: AuditMeta) {
    const campaign = await this.findCampaignOrThrow(id);
    await this.r.campaignModel.findByIdAndUpdate(id, { $set: { isDelete: true } });
    this.log('campaign_deleted', `Campaign "${campaign.name}" deleted`, meta, id);
    return { success: true, message: 'Campaign deleted' };
  }

  /** Cron-driven (see SchedulerService): a campaign whose endDate has passed
   *  stops being served everywhere read paths already check `endDate`, but its
   *  `status` field never flipped off 'active' and it kept its rotation
   *  `order` forever — this is what actually moves it to 'ended', frees its
   *  order slot, and compacts the remaining active campaigns' order values
   *  (0, 1, 2, … with no gaps) so a newly-first campaign really shows as
   *  first instead of leaving a hole where the expired one used to sit. */
  async expireCampaigns(): Promise<{ expired: number }> {
    const now = new Date();
    const expiring = await this.r.campaignModel
      .find({ isDelete: false, status: 'active', endDate: { $lt: now } })
      .select('_id name sponsorType participatingStoreIds endNotifiedAt discountType discountValue startDate')
      .lean();
    if (expiring.length === 0) return { expired: 0 };

    await this.r.campaignModel.updateMany(
      { _id: { $in: expiring.map((c) => c._id) } },
      { $set: { status: 'ended', order: 0 } },
    );
    // A seller's own sale was paused while the campaign ran — it is visible again now, so ask them whether to keep it.
    for (const c of expiring as any[]) this.announceCampaignEnded(c);

    const stillActive = await this.r.campaignModel
      .find({ isDelete: false, status: 'active' })
      .sort({ order: 1 })
      .select('_id order')
      .lean();
    const reorderOps = stillActive
      .map((c, i) => ({ id: c._id, from: c.order, to: i }))
      .filter((c) => c.from !== c.to)
      .map((c) => ({ updateOne: { filter: { _id: c.id }, update: { $set: { order: c.to } } } }));
    if (reorderOps.length > 0) await this.r.campaignModel.bulkWrite(reorderOps);

    return { expired: expiring.length };
  }

  // ─── Platform-wide coupons (scope: 'platform') ──────────────────────────

  async createPlatformCoupon(dto: CreatePlatformCouponDto, meta: AuditMeta) {
    const code = dto.code.trim().toUpperCase();
    if (!Number.isFinite(dto.discountValue) || dto.discountValue <= 0) {
      throw new BadRequestException('Discount value must be greater than 0');
    }
    if (dto.expiresAt && new Date(dto.expiresAt) <= new Date()) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    const existing = await this.r.couponModel.findOne({ scope: 'platform', code, isDelete: false });
    if (existing) throw new ConflictException(`Platform coupon code "${code}" already exists`);

    if (dto.discountType === 'percentage' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    // The unique index on platform codes also covers soft-deleted coupons, so a re-used code is a 409, not a 500.
    const coupon = await this.r.couponModel.create({
      scope: 'platform',
      adminId: meta.adminId,
      code,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      minOrderAmount: dto.minOrderAmount ?? null,
      usageLimit: dto.usageLimit ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      // Fixed amounts on platform coupons are USD (the platform pivot currency) — see coupon.schema.
      currency: dto.discountType === 'fixed' ? 'USD' : null,
    }).catch((err: { code?: number }) => {
      if (err?.code === 11000) throw new ConflictException(`Platform coupon code "${code}" already exists (it may have been deleted earlier)`);
      throw err;
    });

    this.log('platform_coupon_created', `Platform coupon "${code}" created`, meta, String(coupon._id));
    return { success: true, message: 'Platform coupon created', data: coupon };
  }

  async listPlatformCoupons() {
    const coupons = await this.r.couponModel.find({ scope: 'platform', isDelete: false }).sort({ createdAt: -1 }).limit(500);
    return { success: true, data: coupons };
  }

  private async findPlatformCouponOrThrow(id: string) {
    const coupon = await this.r.couponModel.findOne({ _id: id, scope: 'platform', isDelete: false });
    if (!coupon) throw new NotFoundException('Platform coupon not found');
    return coupon;
  }

  async updatePlatformCoupon(id: string, dto: UpdatePlatformCouponDto, meta: AuditMeta) {
    const existing = await this.findPlatformCouponOrThrow(id);
    const mergedValue = (dto as any).discountValue ?? existing.discountValue;
    if (!Number.isFinite(mergedValue) || mergedValue <= 0) throw new BadRequestException('Discount value must be greater than 0');
    if (existing.discountType === 'percentage' && mergedValue > 100) throw new BadRequestException('Percentage discount cannot exceed 100');
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      update[key] = key === 'expiresAt' ? new Date(value as string) : value;
    }
    const coupon = await this.r.couponModel.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
    this.log('platform_coupon_updated', `Platform coupon "${coupon!.code}" updated`, meta, id);
    return { success: true, message: 'Platform coupon updated', data: coupon };
  }

  async deletePlatformCoupon(id: string, meta: AuditMeta) {
    const coupon = await this.findPlatformCouponOrThrow(id);
    await this.r.couponModel.findByIdAndUpdate(id, { $set: { isDelete: true } });
    this.log('platform_coupon_deleted', `Platform coupon "${coupon.code}" deleted`, meta, id);
    return { success: true, message: 'Platform coupon deleted' };
  }
}
