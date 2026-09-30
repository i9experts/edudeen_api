/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
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
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

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
    const filter: Record<string, unknown> = { isDelete: false, order };
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

    const filter: Record<string, unknown> = { isDelete: false };
    if (status) filter.status = status;
    const campaigns = await this.r.campaignModel.find(filter).sort({ createdAt: -1 });
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

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      update[key] = key === 'startDate' || key === 'endDate' ? new Date(value as string) : value;
    }
    const campaign = await this.r.campaignModel.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
    this.log('campaign_updated', `Campaign "${campaign!.name}" updated`, meta, id);
    return { success: true, message: 'Campaign updated', data: campaign };
  }

  async setCampaignStatus(id: string, dto: UpdateCampaignStatusDto, meta: AuditMeta) {
    const campaign = await this.findCampaignOrThrow(id);
    await this.r.campaignModel.findByIdAndUpdate(id, { $set: { status: dto.status } });
    this.log('campaign_status_changed', `Campaign "${campaign.name}" set to ${dto.status}`, meta, id);
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
      .select('_id')
      .lean();
    if (expiring.length === 0) return { expired: 0 };

    await this.r.campaignModel.updateMany(
      { _id: { $in: expiring.map((c) => c._id) } },
      { $set: { status: 'ended', order: 0 } },
    );

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
    const existing = await this.r.couponModel.findOne({ scope: 'platform', code, isDelete: false });
    if (existing) throw new ConflictException(`Platform coupon code "${code}" already exists`);

    if (dto.discountType === 'percentage' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    const coupon = await this.r.couponModel.create({
      scope: 'platform',
      adminId: meta.adminId,
      code,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      minOrderAmount: dto.minOrderAmount ?? null,
      usageLimit: dto.usageLimit ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    this.log('platform_coupon_created', `Platform coupon "${code}" created`, meta, String(coupon._id));
    return { success: true, message: 'Platform coupon created', data: coupon };
  }

  async listPlatformCoupons() {
    const coupons = await this.r.couponModel.find({ scope: 'platform', isDelete: false }).sort({ createdAt: -1 });
    return { success: true, data: coupons };
  }

  private async findPlatformCouponOrThrow(id: string) {
    const coupon = await this.r.couponModel.findOne({ _id: id, scope: 'platform', isDelete: false });
    if (!coupon) throw new NotFoundException('Platform coupon not found');
    return coupon;
  }

  async updatePlatformCoupon(id: string, dto: UpdatePlatformCouponDto, meta: AuditMeta) {
    await this.findPlatformCouponOrThrow(id);
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
