/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import Stripe from 'stripe';
import { DatabaseService } from '../database/databaseservice';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { MediaLibraryService } from '../media-library/media-library.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { EmailService } from '../otp/services/email.service';
import { PromotionPricingService } from './promotion-pricing.service';
import { validateCreativeDimensions } from '../common/validate-creative-dimensions.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { CreatePromotionRequestDto } from './dto/create-promotion-request.dto';
import { PromotionPlacement } from '../common/promotion-placements.const';
import type { PromotionEntityType } from './schemas/promotion-daily-stats.schema';

const EXPIRING_SOON_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — matches the notification's name

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);
  private readonly stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
    private readonly mediaLibraryService: MediaLibraryService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly pricingService: PromotionPricingService,
    private readonly configService: ConfigService,
    private readonly entitlementsService: EntitlementsService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    else this.logger.warn('STRIPE_SECRET_KEY not set — promotion payments are disabled.');
  }

  private get model() {
    return this.databaseService.repositories.promotionRequestModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }
  private get bannerModel() {
    return this.databaseService.repositories.bannerModel;
  }
  private get adminModel() {
    return this.databaseService.repositories.adminModel;
  }
  private get statsModel() {
    return this.databaseService.repositories.promotionDailyStatsModel;
  }
  private get clickEventModel() {
    return this.databaseService.repositories.promotionClickEventModel;
  }
  private get storeBannerModel() {
    return this.databaseService.repositories.storeBannerModel;
  }

  private log(storeId: string, action: string, description: string, actorId: string, actorRole: 'seller' | 'admin', targetId: string) {
    this.activityLogService.log({ storeId, category: 'promotions', action, description, actorId, actorRole, targetId, targetType: 'promotion_request' });
  }

  private async notifyAdmins(subject: string, html: string) {
    try {
      const admins = await this.adminModel.find({}).select('email').lean();
      await Promise.allSettled(admins.map((a: any) => this.emailService.sendMail(a.email, subject, html)));
    } catch (err: any) {
      this.logger.error(`Failed to notify admins: ${err?.message}`);
    }
  }

  // ── Pricing preview ──────────────────────────────────────────────────────────

  async previewPrice(sellerId: string, storeId: string, placement: PromotionPlacement, startAt: string, endAt: string, isPeak = false) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (end <= start) throw new BadRequestException('endAt must be after startAt');
    const breakdown = await this.pricingService.computePrice(placement, start, end, isPeak);
    return { success: true, data: breakdown };
  }

  // ── Seller: create + submit ──────────────────────────────────────────────────

  async create(
    sellerId: string,
    storeId: string,
    dto: CreatePromotionRequestDto,
    file: Express.Multer.File | undefined,
    mobileFile?: Express.Multer.File,
  ) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    await this.entitlementsService.assertCanCreatePromotion(storeId);
    if (!file) throw new BadRequestException('A creative image is required');

    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) throw new BadRequestException('endAt must be after startAt');

    validateCreativeDimensions(file, dto.placement);
    const uploaded = await this.mediaLibraryService.uploadAndTrack(file, 'seller', sellerId, {
      folder: 'uploads/promotions', maxDimension: 1600,
    });
    let mobileUploaded: { url: string; publicId: string } | null = null;
    if (mobileFile) {
      validateCreativeDimensions(mobileFile, 'mobile');
      mobileUploaded = await this.mediaLibraryService.uploadAndTrack(mobileFile, 'seller', sellerId, {
        folder: 'uploads/promotions', maxDimension: 1200,
      });
    }

    const breakdown = await this.pricingService.computePrice(dto.placement, startAt, endAt, dto.isPeak ?? false);

    const request = await this.model.create({
      sellerId, storeId,
      placement: dto.placement,
      creativeUrl: uploaded.url,
      creativePublicId: uploaded.publicId,
      mobileCreativeUrl: mobileUploaded?.url ?? null,
      mobileCreativePublicId: mobileUploaded?.publicId ?? '',
      ctaLabel: dto.ctaLabel ?? null,
      linkType: dto.linkType ?? 'external',
      linkTarget: dto.linkTarget ?? null,
      message: dto.message ?? null,
      startAt, endAt,
      priceUSD: breakdown.priceUSD,
      pricingBreakdown: breakdown as unknown as Record<string, unknown>,
      status: 'pending',
    });

    this.log(storeId, 'promotion_request_submitted', `Promotion request submitted for ${dto.placement}`, sellerId, 'seller', request._id);
    this.notificationsService.notify({
      recipientId: sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_REQUEST_SUBMITTED,
      title: 'Promotion request submitted', body: `Your ${dto.placement} promotion request is awaiting admin review.`,
      data: { promotionRequestId: request._id },
    }).catch(() => {});
    this.notifyAdmins(
      'New promotion request needs review',
      `<p>A seller submitted a new promotion request for <strong>${dto.placement}</strong> (quoted $${breakdown.priceUSD}). Please review it in the admin Marketing → Promotions tab.</p>`,
    );

    return { success: true, message: 'Promotion request submitted', data: request };
  }

  async listForSeller(sellerId: string, storeId?: string) {
    const filter: Record<string, unknown> = { sellerId };
    if (storeId) filter.storeId = storeId;
    const requests = await this.model.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: requests };
  }

  async cancel(sellerId: string, id: string) {
    const request = await this.model.findOne({ _id: id, sellerId });
    if (!request) throw new NotFoundException('Promotion request not found');
    if (!['pending', 'approved', 'active'].includes(request.status)) {
      throw new BadRequestException(`Cannot cancel a request in status "${request.status}"`);
    }

    if (request.paymentStatus === 'paid') {
      await this.refund(request);
    }
    if (request.resultingBannerId) {
      await this.bannerModel.findByIdAndUpdate(request.resultingBannerId, { $set: { status: 'expired', isActive: false } });
    }

    request.status = 'cancelled';
    await request.save();
    this.log(request.storeId, 'promotion_request_cancelled', 'Seller cancelled the promotion request', sellerId, 'seller', id);
    return { success: true, message: 'Promotion request cancelled', data: request };
  }

  async timeline(sellerId: string, id: string) {
    const request = await this.model.findOne({ _id: id, sellerId }).lean();
    if (!request) throw new NotFoundException('Promotion request not found');
    return this.activityLogService.getTimeline(id);
  }

  // ── Admin review ──────────────────────────────────────────────────────────────

  async adminList(status?: string) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    const requests = await this.model.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: requests };
  }

  async approve(adminId: string, id: string) {
    const request = await this.model.findById(id);
    if (!request) throw new NotFoundException('Promotion request not found');
    if (request.status !== 'pending') throw new BadRequestException('Only pending requests can be approved');

    request.status = 'approved';
    request.reviewedBy = adminId;
    request.resolvedAt = new Date();
    await request.save();

    this.log(request.storeId, 'promotion_request_approved', 'Promotion request approved', adminId, 'admin', id);
    this.notificationsService.notify({
      recipientId: request.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_APPROVED,
      title: 'Promotion request approved', body: `Your ${request.placement} promotion was approved — complete payment to go live.`,
      data: { promotionRequestId: id },
    }).catch(() => {});

    return { success: true, message: 'Promotion request approved', data: request };
  }

  async reject(adminId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('rejectionReason is required');
    const request = await this.model.findById(id);
    if (!request) throw new NotFoundException('Promotion request not found');
    if (request.status !== 'pending') throw new BadRequestException('Only pending requests can be rejected');

    request.status = 'rejected';
    request.rejectionReason = reason;
    request.reviewedBy = adminId;
    request.resolvedAt = new Date();
    await request.save();

    this.log(request.storeId, 'promotion_request_rejected', `Promotion request rejected: ${reason}`, adminId, 'admin', id);
    this.notificationsService.notify({
      recipientId: request.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_REJECTED,
      title: 'Promotion request rejected', body: reason,
      data: { promotionRequestId: id },
    }).catch(() => {});

    return { success: true, message: 'Promotion request rejected', data: request };
  }

  // ── Payment ───────────────────────────────────────────────────────────────────

  async createPaymentIntent(sellerId: string, id: string) {
    if (!this.stripe) throw new BadRequestException('Online payments are not configured yet.');
    const request = await this.model.findOne({ _id: id, sellerId });
    if (!request) throw new NotFoundException('Promotion request not found');
    if (request.status !== 'approved') throw new BadRequestException('This request has not been approved yet');
    if (request.paymentStatus === 'paid') throw new BadRequestException('This request is already paid');

    const amountCents = Math.round(request.priceUSD * 100);
    const idempotencyKey = `promotion_${id}_${amountCents}`;

    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        metadata: { promotionRequestId: id, sellerId },
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      { idempotencyKey },
    );

    request.stripePaymentIntentId = paymentIntent.id;
    await request.save();

    return { success: true, data: { clientSecret: paymentIntent.client_secret, amount: request.priceUSD } };
  }

  private async activatePaidRequest(request: any) {
    // Guards against running twice — this is reachable from both the Stripe
    // webhook (handlePaymentSucceeded) and the client-confirm path
    // (confirmPayment), and either can legitimately race the other.
    if (request.resultingBannerId) return;

    // Resulting Banner is created once, directly, at the moment payment is
    // confirmed (or immediately by the cron once startAt arrives) — not a
    // second reconciliation pass that could drift from this request's data.
    const currentCount = await this.bannerModel.countDocuments({ placement: request.placement });
    const banner = await this.bannerModel.create({
      bannerImage: request.creativeUrl,
      publicId: request.creativePublicId,
      urlOnTap: request.linkTarget,
      placement: request.placement,
      status: 'active',
      isActive: true,
      startAt: request.startAt,
      endAt: request.endAt,
      order: currentCount,
    });
    request.resultingBannerId = banner._id;
    request.status = 'active';
    await request.save();

    this.log(request.storeId, 'promotion_request_live', 'Promotion went live', request.sellerId, 'seller', request._id.toString());
    this.notificationsService.notify({
      recipientId: request.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_GOING_LIVE,
      title: 'Your promotion is live', body: `Your ${request.placement} promotion is now showing.`,
      data: { promotionRequestId: request._id },
    }).catch(() => {});
  }

  // Shared by both activation triggers — the Stripe webhook (arrives async,
  // seconds later, and needs local Stripe CLI forwarding to ever reach a dev
  // machine) and the client-confirm path (confirmPayment, below), which
  // verifies directly with Stripe right after the card form succeeds so the
  // seller doesn't have to wait on/depend on a webhook for the demo to work.
  // Safe to call from both — `paymentStatus` and `activatePaidRequest`'s own
  // `resultingBannerId` guard make whichever one runs second a no-op.
  private async markPaidAndMaybeActivate(request: any) {
    request.paymentStatus = 'paid';
    await request.save();
    this.notificationsService.notify({
      recipientId: request.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_PAYMENT_SUCCEEDED,
      title: 'Payment received', body: `Payment of $${request.priceUSD} for your ${request.placement} promotion succeeded.`,
      data: { promotionRequestId: request._id },
    }).catch(() => {});

    if (request.startAt.getTime() <= Date.now()) {
      await this.activatePaidRequest(request);
    }
  }

  @OnEvent('stripe.payment_intent.succeeded')
  async handlePaymentSucceeded(paymentIntent: any): Promise<void> {
    const requestId = paymentIntent.metadata?.promotionRequestId;
    if (!requestId) return; // not ours — another listener owns this event
    const request = await this.model.findById(requestId);
    if (!request || request.paymentStatus === 'paid') return;
    await this.markPaidAndMaybeActivate(request);
  }

  // ── Client-confirm (called right after Stripe Elements confirms the card
  // payment) — verifies the PaymentIntent's real status directly with Stripe
  // (never trusts the client's word alone) and activates immediately instead
  // of waiting on the webhook, which in local dev only arrives if Stripe CLI
  // is forwarding to this machine. The webhook still runs too whenever it
  // does arrive — this is a second, redundant trigger, not a replacement.

  async confirmPayment(sellerId: string, id: string) {
    if (!this.stripe) throw new BadRequestException('Online payments are not configured yet.');
    const request = await this.model.findOne({ _id: id, sellerId });
    if (!request) throw new NotFoundException('Promotion request not found');
    if (request.paymentStatus === 'paid') return { success: true, message: 'Already confirmed', data: request };
    if (!request.stripePaymentIntentId) throw new BadRequestException('No payment has been started for this request');

    const paymentIntent = await this.stripe.paymentIntents.retrieve(request.stripePaymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      throw new BadRequestException(`Payment has not completed yet (status: ${paymentIntent.status}).`);
    }

    await this.markPaidAndMaybeActivate(request);
    return { success: true, message: 'Payment confirmed', data: request };
  }

  @OnEvent('stripe.payment_intent.payment_failed')
  async handlePaymentFailed(paymentIntent: any): Promise<void> {
    const requestId = paymentIntent.metadata?.promotionRequestId;
    if (!requestId) return;
    const request = await this.model.findById(requestId);
    if (!request) return;

    request.paymentStatus = 'failed';
    await request.save();
    this.notificationsService.notify({
      recipientId: request.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_PAYMENT_FAILED,
      title: 'Payment failed', body: `Payment for your ${request.placement} promotion failed. Please try again.`,
      data: { promotionRequestId: requestId },
    }).catch(() => {});
  }

  private async refund(request: any) {
    if (!this.stripe || !request.stripePaymentIntentId) return;
    try {
      const pi = await this.stripe.paymentIntents.retrieve(request.stripePaymentIntentId);
      const chargeId = (pi as any).latest_charge;
      if (chargeId) {
        await this.stripe.refunds.create({ charge: chargeId }, { idempotencyKey: `promotion_refund_${request._id}` });
      }
      request.paymentStatus = 'refunded';
    } catch (err: any) {
      this.logger.error(`Refund failed for promotion request ${request._id}: ${err?.message}`);
    }
  }

  // ── Conflict detection (used by both the approval-time warning and the calendar) ──

  async checkConflicts(placement: PromotionPlacement, startAt: Date, endAt: Date, excludeId?: string) {
    const filter: Record<string, unknown> = {
      placement,
      status: { $in: ['approved', 'active'] },
      startAt: { $lt: endAt },
      endAt: { $gt: startAt },
    };
    if (excludeId) filter._id = { $ne: excludeId };

    const overlapping = await this.model.find(filter).select('_id storeId startAt endAt priceUSD').lean();
    const visibleLimit = await this.adminConfigService.getPlacementLimit(placement);
    return {
      success: true,
      data: {
        overlappingCount: overlapping.length,
        visibleLimit,
        isOversubscribed: overlapping.length >= visibleLimit,
        overlapping,
      },
    };
  }

  async calendar(from: Date, to: Date) {
    const { campaignModel } = this.databaseService.repositories;
    const [promotions, campaigns] = await Promise.all([
      this.model.find({ startAt: { $lt: to }, endAt: { $gt: from }, status: { $in: ['approved', 'active'] } })
        .select('placement storeId startAt endAt priceUSD status').lean(),
      campaignModel.find({ startDate: { $lt: to }, endDate: { $gt: from }, status: { $ne: 'draft' } })
        .select('name startDate endDate status').lean(),
    ]);
    return { success: true, data: { promotions, campaigns } };
  }

  // ── Cron: activation / expiry / expiring-soon notification ─────────────────────
  // Sibling to `AdminMarketingService.expireCampaigns()` — same shape, same
  // order-compaction convention, registered as its own job in SchedulerService.

  async runExpiryAndActivation(): Promise<{ activated: number; expired: number; expiringSoonNotified: number }> {
    const now = new Date();

    const toActivate = await this.model.find({ status: 'approved', paymentStatus: 'paid', startAt: { $lte: now } });
    for (const request of toActivate) {
      await this.activatePaidRequest(request);
    }

    const expiringSoonCutoff = new Date(now.getTime() + EXPIRING_SOON_WINDOW_MS);
    const toWarn = await this.model.find({
      status: 'active', endAt: { $lte: expiringSoonCutoff, $gt: now }, expiringSoonNotifiedAt: null,
    });
    for (const request of toWarn) {
      request.expiringSoonNotifiedAt = now;
      await request.save();
      this.notificationsService.notify({
        recipientId: request.sellerId, recipientRole: 'seller',
        type: NOTIFICATION_TYPES.PROMOTION_EXPIRING_SOON,
        title: 'Promotion expiring soon', body: `Your ${request.placement} promotion ends within 6 hours.`,
        data: { promotionRequestId: request._id },
      }).catch(() => {});
    }

    const toExpire = await this.model.find({ status: 'active', endAt: { $lte: now } });
    for (const request of toExpire) {
      request.status = 'expired';
      await request.save();
      if (request.resultingBannerId) {
        await this.bannerModel.findByIdAndUpdate(request.resultingBannerId, { $set: { status: 'expired', isActive: false } });
      }
      this.notificationsService.notify({
        recipientId: request.sellerId, recipientRole: 'seller',
        type: NOTIFICATION_TYPES.PROMOTION_EXPIRED,
        title: 'Promotion ended', body: `Your ${request.placement} promotion has ended.`,
        data: { promotionRequestId: request._id },
      }).catch(() => {});
    }

    // Compact remaining active Banner order per placement touched, same as Campaign's cron.
    const touchedPlacements = new Set([...toActivate, ...toExpire].map((r: any) => r.placement));
    for (const placement of touchedPlacements) {
      const active = await this.bannerModel.find({ placement, status: 'active' }).sort({ order: 1 });
      const ops = active
        .map((b, i) => ({ id: b._id, to: i }))
        .filter((x, i) => active[i].order !== x.to)
        .map((x) => ({ updateOne: { filter: { _id: x.id }, update: { $set: { order: x.to } } } }));
      if (ops.length) await this.bannerModel.bulkWrite(ops);
    }

    return { activated: toActivate.length, expired: toExpire.length, expiringSoonNotified: toWarn.length };
  }

  // ── Analytics: tracking + rollups ───────────────────────────────────────────────

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async bumpDailyStats(entityType: PromotionEntityType, entityId: string, inc: Record<string, number>, device?: 'desktop' | 'mobile' | 'tablet') {
    const set: Record<string, number> = { ...inc };
    if (device) set[`byDevice.${device}`] = 1;
    await this.statsModel.updateOne(
      { entityType, entityId, date: this.todayKey() },
      { $inc: set },
      { upsert: true },
    );
    // An approved paid promotion runs as a platform banner, and buyers' pages
    // report views/clicks against that banner — count them for the seller's
    // promotion too, so their promotion analytics show real numbers.
    if (entityType === 'banner') {
      const promotionId = await this.promotionForBanner(entityId);
      if (promotionId) {
        await this.statsModel.updateOne(
          { entityType: 'promotion_request', entityId: promotionId, date: this.todayKey() },
          { $inc: set },
          { upsert: true },
        );
      }
    }
  }

  private bannerPromotionCache = new Map<string, { id: string | null; at: number }>();
  private async promotionForBanner(bannerId: string): Promise<string | null> {
    const hit = this.bannerPromotionCache.get(bannerId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.id;
    const promo: any = await this.databaseService.repositories.promotionRequestModel.findOne({ resultingBannerId: bannerId }).select('_id').lean();
    const id = promo ? String(promo._id) : null;
    this.bannerPromotionCache.set(bannerId, { id, at: Date.now() });
    return id;
  }

  async trackImpression(entityType: PromotionEntityType, entityId: string, device?: 'desktop' | 'mobile' | 'tablet') {
    await this.bumpDailyStats(entityType, entityId, { impressions: 1 }, device);
    return { success: true };
  }

  async trackClick(entityType: PromotionEntityType, entityId: string, device: 'desktop' | 'mobile' | 'tablet' = 'desktop', country?: string, city?: string, buyerId?: string | null) {
    await this.bumpDailyStats(entityType, entityId, { clicks: 1 }, device);
    if (country) {
      await this.statsModel.updateOne(
        { entityType, entityId, date: this.todayKey() },
        { $inc: { [`byCountry.${country}`]: 1 } },
        { upsert: true },
      );
    }
    const event = await this.clickEventModel.create({ entityType, entityId, device, country: country ?? null, city: city ?? null, buyerId: buyerId ?? null });
    return { success: true, data: { clickId: event._id } };
  }

  /** Called fire-and-forget from PaymentService once order(s) are created for a checkout that carried an attribution id. */
  async recordConversions(conversions: { entityType: PromotionEntityType; entityId: string; orderId: string; revenue: number }[]) {
    for (const c of conversions) {
      await this.bumpDailyStats(c.entityType, c.entityId, { conversions: 1, orders: 1, revenueUSD: c.revenue });
    }
  }

  private async aggregateStats(filter: Record<string, unknown>) {
    const rows = await this.statsModel.find(filter).lean();
    const totals = rows.reduce(
      (acc, r: any) => ({
        impressions: acc.impressions + r.impressions,
        clicks: acc.clicks + r.clicks,
        conversions: acc.conversions + r.conversions,
        revenueUSD: acc.revenueUSD + r.revenueUSD,
        orders: acc.orders + r.orders,
      }),
      { impressions: 0, clicks: 0, conversions: 0, revenueUSD: 0, orders: 0 },
    );
    const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    const byDate = rows
      .map((r: any) => ({ date: r.date, impressions: r.impressions, clicks: r.clicks, revenueUSD: r.revenueUSD }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { ...totals, ctr, byDate };
  }

  /** Seller-facing: analytics across every StoreBanner belonging to this store, plus
   *  the resulting Banner of every PromotionRequest that went live — never the
   *  PromotionRequest id itself, since buyers never click that document directly. */
  async getSellerAnalytics(sellerId: string, storeId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const [storeBanners, requests] = await Promise.all([
      this.storeBannerModel.find({ storeId }).select('_id').lean(),
      this.model.find({ storeId, resultingBannerId: { $ne: null } }).select('resultingBannerId').lean(),
    ]);
    const storeBannerIds = storeBanners.map((b: any) => b._id.toString());
    const bannerIds = requests.map((r: any) => r.resultingBannerId).filter(Boolean);
    if (!storeBannerIds.length && !bannerIds.length) {
      return { success: true, data: { impressions: 0, clicks: 0, conversions: 0, revenueUSD: 0, orders: 0, ctr: 0, byDate: [] } };
    }
    const data = await this.aggregateStats({
      $or: [
        { entityType: 'store_banner', entityId: { $in: storeBannerIds } },
        { entityType: 'banner', entityId: { $in: bannerIds } },
      ],
    });
    return { success: true, data };
  }

  /** Admin-facing: platform-wide promotion performance (Banner + PromotionRequest placements). */
  async getAdminAnalytics() {
    const data = await this.aggregateStats({ entityType: { $in: ['banner', 'promotion_request'] } });
    const revenueFromPromotions = await this.model.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$priceUSD' } } },
    ]);
    return { success: true, data: { ...data, platformRevenueUSD: revenueFromPromotions[0]?.total ?? 0 } };
  }
}
