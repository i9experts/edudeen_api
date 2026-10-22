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

  /** Refund owed for cancelling now: full before the run starts, pro-rated by remaining time while live, nothing after the end. */
  proratedRefundUSD(request: { priceUSD: number; startAt: Date; endAt: Date }, now = new Date()): number {
    const start = new Date(request.startAt).getTime();
    const end = new Date(request.endAt).getTime();
    const n = now.getTime();
    if (n <= start) return request.priceUSD;
    if (n >= end || end <= start) return 0;
    const cents = Math.floor(request.priceUSD * 100 * ((end - n) / (end - start)));
    return cents / 100;
  }

  async cancel(sellerId: string, id: string) {
    const request = await this.model.findOne({ _id: id, sellerId });
    if (!request) throw new NotFoundException('Promotion request not found');
    if (!['pending', 'approved', 'active'].includes(request.status)) {
      throw new BadRequestException(`Cannot cancel a request in status "${request.status}"`);
    }

    // Money first: if the seller paid, the refund must succeed before we mark it cancelled.
    let refundedUSD = 0;
    if (request.paymentStatus === 'paid') {
      const owed = this.proratedRefundUSD(request);
      if (owed > 0) {
        const result = await this.refund(request, owed);
        if (!result.ok) {
          await this.alertRefundProblem(request, `Seller cancel: refund of $${owed} failed (${result.error})`);
          throw new BadRequestException('We could not refund your payment right now, so the promotion was not cancelled. Please try again shortly or contact support.');
        }
        refundedUSD = result.amountUSD;
      }
    }

    const set: Record<string, unknown> = { status: 'cancelled' };
    if (refundedUSD > 0) { set.paymentStatus = 'refunded'; set.refundedUSD = refundedUSD; }
    // Atomic: only one cancel wins, and a request that went to another state meanwhile is left alone.
    const cancelled = await this.model.findOneAndUpdate(
      { _id: id, sellerId, status: { $in: ['pending', 'approved', 'active'] } },
      { $set: set },
      { new: true },
    );
    if (!cancelled) {
      if (refundedUSD > 0) await this.alertRefundProblem(request, `Seller cancel raced with another change after a $${refundedUSD} refund; check this promotion's state`);
      throw new BadRequestException('This request changed while cancelling. Please refresh and try again.');
    }
    const bannerId = cancelled.resultingBannerId || request.resultingBannerId;
    if (bannerId) {
      await this.bannerModel.findByIdAndUpdate(bannerId, { $set: { status: 'expired', isActive: false } });
    }

    this.log(request.storeId, 'promotion_request_cancelled', refundedUSD > 0 ? `Seller cancelled the promotion request (refunded $${refundedUSD})` : 'Seller cancelled the promotion request', sellerId, 'seller', id);
    return { success: true, message: 'Promotion request cancelled', data: cancelled };
  }

  async timeline(sellerId: string, id: string) {
    const request = await this.model.findOne({ _id: id, sellerId }).lean();
    if (!request) throw new NotFoundException('Promotion request not found');
    return this.activityLogService.getTimeline(id);
  }

  // ── Admin review ──────────────────────────────────────────────────────────────

  async adminList(status?: string, page = 1, limit = 100) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    const take = Math.min(Math.max(Math.floor(Number(limit)) || 100, 1), 200);
    const pageNo = Math.max(Math.floor(Number(page)) || 1, 1);
    const [requests, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((pageNo - 1) * take).limit(take).lean(),
      this.model.countDocuments(filter),
    ]);
    return { success: true, data: requests, pagination: { page: pageNo, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async approve(adminId: string, id: string) {
    // Atomic: only a request that is still pending can be approved (two admins / double click).
    const request = await this.model.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', reviewedBy: adminId, resolvedAt: new Date() } },
      { new: true },
    );
    if (!request) {
      if (!(await this.model.exists({ _id: id }))) throw new NotFoundException('Promotion request not found');
      throw new BadRequestException('Only pending requests can be approved');
    }

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
    const request = await this.model.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'rejected', rejectionReason: reason, reviewedBy: adminId, resolvedAt: new Date() } },
      { new: true },
    );
    if (!request) {
      if (!(await this.model.exists({ _id: id }))) throw new NotFoundException('Promotion request not found');
      throw new BadRequestException('Only pending requests can be rejected');
    }

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
    // Reachable from the Stripe webhook, the client-confirm path and the cron,
    // which can race. The claim is atomic: only the caller that flips
    // approved -> active (with no banner yet) goes on to create the banner.
    const claimed = await this.model.findOneAndUpdate(
      { _id: request._id, status: 'approved', paymentStatus: 'paid', resultingBannerId: null },
      { $set: { status: 'active' } },
      { new: true },
    );
    if (!claimed) return;

    let banner: any;
    try {
      const currentCount = await this.bannerModel.countDocuments({ placement: claimed.placement });
      banner = await this.bannerModel.create({
        bannerImage: claimed.creativeUrl,
        publicId: claimed.creativePublicId,
        urlOnTap: claimed.linkTarget,
        placement: claimed.placement,
        status: 'active',
        isActive: true,
        startAt: claimed.startAt,
        endAt: claimed.endAt,
        order: currentCount,
      });
    } catch (err: any) {
      // Hand the claim back so the next cron tick retries.
      await this.model.updateOne({ _id: claimed._id, status: 'active', resultingBannerId: null }, { $set: { status: 'approved' } });
      this.logger.error(`Could not create banner for promotion ${claimed._id}: ${err?.message}`);
      return;
    }

    const linked = await this.model.updateOne(
      { _id: claimed._id, status: 'active' },
      { $set: { resultingBannerId: banner._id } },
    );
    if (!linked.modifiedCount) {
      // Cancelled between the claim and now: do not leave an orphan banner live.
      await this.bannerModel.findByIdAndUpdate(banner._id, { $set: { status: 'expired', isActive: false } });
      return;
    }

    this.log(claimed.storeId, 'promotion_request_live', 'Promotion went live', claimed.sellerId, 'seller', String(claimed._id));
    this.notificationsService.notify({
      recipientId: claimed.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_GOING_LIVE,
      title: 'Your promotion is live', body: `Your ${claimed.placement} promotion is now showing.`,
      data: { promotionRequestId: claimed._id },
    }).catch(() => {});
  }

  /** Tells admins a refund failed or a payment needs manual attention (activity log + e-mail). */
  private async alertRefundProblem(request: any, message: string) {
    this.activityLogService.log({
      storeId: request.storeId, category: 'promotions', action: 'promotion_refund_alert',
      description: message, actorRole: 'system', targetId: String(request._id), targetType: 'promotion_request',
      isSecurityAlert: true, metadata: { promotionRequestId: String(request._id), priceUSD: request.priceUSD },
    });
    this.logger.error(`Promotion ${request._id}: ${message}`);
    await this.notifyAdmins('Promotion payment needs attention', `<p>${message}</p><p>Promotion request: ${request._id} (store ${request.storeId}).</p>`);
  }

  // Shared by both activation triggers — the Stripe webhook and the client-confirm
  // path (confirmPayment). Safe to call from both: the paid-claim below is atomic,
  // so whichever runs second is a no-op.
  // Returns 'paid' | 'already_paid' | 'refunded' (late payment on a request that
  // is no longer approved: money sent back) | 'refund_failed' (admins alerted).
  private async markPaidAndMaybeActivate(request: any, paymentIntentId?: string): Promise<'paid' | 'already_paid' | 'refunded' | 'refund_failed'> {
    // Only an approved request that has not been paid can take payment.
    const paid = await this.model.findOneAndUpdate(
      { _id: request._id, status: 'approved', paymentStatus: { $in: ['pending', 'failed'] } },
      { $set: { paymentStatus: 'paid' } },
      { new: true },
    );

    if (!paid) {
      const current: any = await this.model.findById(request._id);
      if (!current) return 'already_paid';
      if (current.paymentStatus === 'paid' || current.paymentStatus === 'refunded') return 'already_paid';
      // Late payment: the request was cancelled / rejected / expired meanwhile. Return the money.
      const piId = paymentIntentId || current.stripePaymentIntentId;
      const result = await this.refund({ ...current.toObject(), stripePaymentIntentId: piId, _id: current._id }, current.priceUSD);
      if (result.ok) {
        await this.model.updateOne({ _id: current._id }, { $set: { paymentStatus: 'refunded', refundedUSD: result.amountUSD } });
        await this.alertRefundProblem(current, `Payment of $${current.priceUSD} arrived for a promotion in status "${current.status}" and was refunded automatically.`);
        return 'refunded';
      }
      await this.model.updateOne({ _id: current._id }, { $set: { paymentStatus: 'paid' } });
      await this.alertRefundProblem(current, `Payment of $${current.priceUSD} arrived for a promotion in status "${current.status}" and the automatic refund FAILED (${result.error}). Refund it manually in Stripe.`);
      return 'refund_failed';
    }

    this.notificationsService.notify({
      recipientId: paid.sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PROMOTION_PAYMENT_SUCCEEDED,
      title: 'Payment received', body: `Payment of $${paid.priceUSD} for your ${paid.placement} promotion succeeded.`,
      data: { promotionRequestId: paid._id },
    }).catch(() => {});

    if (paid.startAt.getTime() <= Date.now()) {
      await this.activatePaidRequest(paid);
    }
    return 'paid';
  }

  @OnEvent('stripe.payment_intent.succeeded')
  async handlePaymentSucceeded(paymentIntent: any): Promise<void> {
    const requestId = paymentIntent.metadata?.promotionRequestId;
    if (!requestId) return; // not ours — another listener owns this event
    const request = await this.model.findById(requestId);
    if (!request || request.paymentStatus === 'paid' || request.paymentStatus === 'refunded') return;
    await this.markPaidAndMaybeActivate(request, paymentIntent.id);
  }

  // ── Client-confirm (called right after Stripe Elements confirms the card
  // payment) — verifies the PaymentIntent's real status directly with Stripe
  // (never trusts the client's word alone) and activates immediately instead
  // of waiting on the webhook. The webhook still runs too whenever it arrives.

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

    const outcome = await this.markPaidAndMaybeActivate(request, paymentIntent.id);
    if (outcome === 'refunded') throw new BadRequestException(`This promotion is no longer open for payment (status: ${request.status}). Your payment was refunded.`);
    if (outcome === 'refund_failed') throw new BadRequestException('This promotion is no longer open for payment. We are refunding your payment manually; support has been notified.');
    const fresh = await this.model.findById(id);
    return { success: true, message: 'Payment confirmed', data: fresh ?? request };
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

  /**
   * Refund `amountUSD` of a paid promotion. Never double-refunds: if Stripe already
   * holds a refund on the charge we treat it as done. Returns {ok:false} instead of
   * swallowing the error so callers can refuse to change state.
   */
  private async refund(request: any, amountUSD: number): Promise<{ ok: true; amountUSD: number } | { ok: false; error: string }> {
    if (!this.stripe) return { ok: false, error: 'Stripe is not configured' };
    if (!request.stripePaymentIntentId) return { ok: false, error: 'no payment on file' };
    try {
      const pi = await this.stripe.paymentIntents.retrieve(request.stripePaymentIntentId);
      const chargeId = (pi as any).latest_charge;
      if (!chargeId) return { ok: false, error: 'no charge to refund' };
      const existing = await this.stripe.refunds.list({ charge: chargeId, limit: 10 });
      const alreadyCents = existing.data
        .filter((r: any) => r.status !== 'failed' && r.status !== 'canceled')
        .reduce((s: number, r: any) => s + (r.amount ?? 0), 0);
      if (alreadyCents > 0) return { ok: true, amountUSD: alreadyCents / 100 };
      const cents = Math.round(amountUSD * 100);
      await this.stripe.refunds.create(
        { charge: chargeId, amount: cents },
        { idempotencyKey: `promotion_refund_${request._id}` },
      );
      return { ok: true, amountUSD: cents / 100 };
    } catch (err: any) {
      this.logger.error(`Refund failed for promotion request ${request._id}: ${err?.message}`);
      return { ok: false, error: err?.message ?? 'refund error' };
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
