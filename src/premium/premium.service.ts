/* eslint-disable prettier/prettier */
import { assertProofFile } from 'src/common/proof-file.util';
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { CommissionRulesService } from '../commission-rules/commission-rules.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';
import { clampInt, escapeRegex } from '../common/query-safety.util';
import {
  PremiumBenefits, PremiumCouponIssue, PremiumCouponIssueDocument, PremiumMembership, PremiumMembershipDocument,
  PremiumPayment, PremiumPaymentDocument, PremiumPlan, PremiumPlanDocument, PremiumSettings, PremiumSettingsDocument,
} from './premium.schemas';
import { PremiumEntitlementsService } from './premium-entitlements.service';
import { addPeriod, cleanPremiumSettings, DEFAULT_CHILDREN_LIMIT, monthKey, normalSalePercent, premiumGapViolation, premiumPercentFor, termsFromSettings } from './premium.util';
import {
  CreatePremiumPlanDto, GrantPremiumDto, SubmitPremiumProofDto, SubscribePremiumDto, UpdatePremiumPlanDto,
} from './premium.dto';

const WEB = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');
const PROOF_FOLDER = 'private/premium-payment-proofs';
const PROOF_URL_TTL_SECONDS = 10 * 60;
const DAY = 86_400_000;
const EXPIRING_SOON_DAYS = 3;
const DEFAULT_BENEFITS: PremiumBenefits = { childrenLimit: 15, earlyAccessHours: 2, monthlyCouponValue: 0, monthlyCouponType: 'percentage', prioritySupport: true };

const round2 = (n: number) => Math.round(n * 100) / 100;

// TODO(card billing): memberships have `source: 'stripe'` reserved. Card billing (Stripe subscription or one-off
// Checkout Session -> activate() on the webhook) can be added later WITHOUT changing the model: create a payment
// with source 'stripe', call this.activate(...) when it succeeds. Intentionally not built now (bank transfer only).

@Injectable()
export class PremiumService {
  private readonly logger = new Logger(PremiumService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly uploadService: UploadService,
    private readonly adminConfig: AdminConfigService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
    private readonly entitlements: PremiumEntitlementsService,
    @InjectModel(PremiumPlan.name) private readonly planModel: Model<PremiumPlanDocument>,
    @InjectModel(PremiumMembership.name) private readonly membershipModel: Model<PremiumMembershipDocument>,
    @InjectModel(PremiumPayment.name) private readonly paymentModel: Model<PremiumPaymentDocument>,
    @InjectModel(PremiumCouponIssue.name) private readonly couponIssueModel: Model<PremiumCouponIssueDocument>,
    @InjectModel(PremiumSettings.name) private readonly settingsModel: Model<PremiumSettingsDocument>,
    @Optional() private readonly commissionRules?: CommissionRulesService,
  ) {}

  getEntitlements(userId?: string | null) { return this.entitlements.getEntitlements(userId); }

  // ── helpers ──────────────────────────────────────────────────────────────

  private benefitsOf(raw: Partial<PremiumBenefits> | undefined | null): PremiumBenefits {
    const b = raw ?? {};
    return {
      childrenLimit: Math.max(DEFAULT_CHILDREN_LIMIT, Number(b.childrenLimit ?? DEFAULT_BENEFITS.childrenLimit)),
      earlyAccessHours: Math.max(0, Number(b.earlyAccessHours ?? DEFAULT_BENEFITS.earlyAccessHours)),
      monthlyCouponValue: Math.max(0, Number(b.monthlyCouponValue ?? DEFAULT_BENEFITS.monthlyCouponValue)),
      monthlyCouponType: b.monthlyCouponType === 'fixed' ? 'fixed' : 'percentage',
      prioritySupport: b.prioritySupport !== false,
    };
  }

  private effectiveYearlyUSD(plan: any): number {
    return round2(plan.yearlyPriceUSD != null ? plan.yearlyPriceUSD : plan.monthlyPriceUSD * 12);
  }

  private priceUSD(plan: any, interval: 'monthly' | 'yearly'): number {
    return interval === 'yearly' ? this.effectiveYearlyUSD(plan) : round2(plan.monthlyPriceUSD);
  }

  /** PKR display/charge rate; null when no rate exists yet (never throws). */
  private async pkrRate(): Promise<number | null> {
    try {
      const r: any = await this.exchangeRate.getCurrentRate('PKR');
      if (r?.ratePerUSD > 0) return Number(r.ratePerUSD);
    } catch { /* fall through */ }
    // No stored rate yet (fresh install / cron not run): fetch on demand, then fall back to the admin's bank-transfer rate.
    try {
      const [s] = await this.exchangeRate.buildSnapshots(['PKR']);
      if (s?.ratePerUSD > 0) return Number(s.ratePerUSD);
    } catch { /* fall through */ }
    try {
      const mp: any = await this.adminConfig.getManualPaymentConfig();
      return mp?.usdToPkrRate > 0 ? Number(mp.usdToPkrRate) : null;
    } catch { return null; }
  }

  private presentPlan(p: any, rate: number | null) {
    const yearly = this.effectiveYearlyUSD(p);
    const monthly = round2(p.monthlyPriceUSD);
    return {
      _id: String(p._id), name: p.name, description: p.description ?? '',
      monthlyPriceUSD: monthly, yearlyPriceUSD: yearly,
      monthlyPricePKR: rate ? Math.round(monthly * rate) : null,
      yearlyPricePKR: rate ? Math.round(yearly * rate) : null,
      fxRate: rate,
      yearlySavingsPercent: monthly > 0 ? Math.max(0, Math.round((1 - yearly / (monthly * 12)) * 100)) : 0,
      isActive: !!p.isActive, sortOrder: p.sortOrder ?? 0,
      benefits: this.benefitsOf(p.benefits),
    };
  }

  private proofUrl(p: any): string | null {
    return p?.proofPublicId ? this.uploadService.generateSignedUrl(p.proofPublicId, p.proofResourceType ?? 'image', PROOF_URL_TTL_SECONDS, undefined, true) : null;
  }

  private presentPayment(p: any) {
    const { proofPublicId, proofResourceType, ...rest } = p?.toObject ? p.toObject() : p;
    return { ...rest, hasProof: !!proofPublicId, proofImageUrl: this.proofUrl({ proofPublicId, proofResourceType }) };
  }

  private async audit(adminId: string, action: string, description: string, targetId: string | null, targetType: string, metadata?: object) {
    await this.activityLog.log({ category: 'platform_plans', action, description, actorId: adminId, actorRole: 'admin', targetId, targetType, metadata: metadata ?? null });
  }

  private async locked(name: string, ttlMs: number, fn: () => Promise<void>) {
    try {
      const r = await this.redis.withLock(`cron-lock:${name}`, ttlMs, fn);
      if (r === 'lock_not_acquired') this.logger.debug(`Skipped "${name}" (lock held or Redis down)`);
    } catch (err: any) {
      this.logger.error(`Premium job "${name}" failed: ${err?.message}`);
    }
  }

  private async notifyUser(userId: string, type: string, title: string, body: string, data: Record<string, any>, emailHtml?: string) {
    try {
      let email: { subject: string; html: string } | undefined;
      if (emailHtml) {
        const user: any = await this.db.repositories.userModel.findById(userId).select('email isVerified').lean();
        if (user?.email && user.isVerified !== false) email = { subject: title, html: emailHtml };
      }
      await this.notifications.notify({ recipientId: userId, recipientRole: 'user', type, title, body, data, ...(email ? { email } : {}) });
    } catch (err: any) {
      this.logger.warn(`premium notification to ${userId} failed: ${err?.message}`);
    }
  }

  // ── platform offer / fee / gap settings (R4) ─────────────────────────────

  async adminGetSettings() {
    const settings = await this.entitlements.getSettings();
    return { success: true, data: { ...settings, effective: termsFromSettings(settings) } };
  }

  async adminUpdateSettings(adminId: string, body: any) {
    const current = await this.entitlements.getSettings();
    const next = cleanPremiumSettings(body, current);
    await this.settingsModel.findOneAndUpdate(
      { key: 'default' },
      { $set: { platformDiscount: next.platformDiscount, premiumSellerFeePercent: next.premiumSellerFeePercent, minGapPercent: next.minGapPercent, updatedByAdminId: adminId }, $setOnInsert: { key: 'default' } },
      { upsert: true, returnDocument: 'after' },
    );
    this.entitlements.invalidateSettings();
    await this.audit(adminId, 'premium_settings_updated', `Premium settings: platform offer ${next.platformDiscount.enabled ? `ON ${next.platformDiscount.percent}%` : 'OFF'}, seller fee on premium sales ${next.premiumSellerFeePercent}%, min gap ${next.minGapPercent} points`, 'default', 'premium_settings', { before: current, after: next });
    return { success: true, message: 'Premium settings saved', data: { ...next, effective: termsFromSettings(next) } };
  }

  /**
   * Public / seller-readable: the numbers the seller's earnings calculator and the sale-vs-premium rule use.
   * `type` (physical | digital | educational | course) adds the normal per-type platform fee; `currency` converts a fixed fee.
   * `normalFee` is the fee ACTUALLY charged on a normal sale: PlatformConfig.platformFees[type] when set (source
   * 'platform_fees'), else the legacy commission-rule rate for the store (source 'commission_rules' - the same fallback
   * FinanceService.recordSale uses; per-store override when `storeId` is given). null = no fee can be determined.
   */
  async getTerms(type?: string, currency?: string, storeId?: string) {
    const settings = await this.entitlements.getSettings();
    const t = termsFromSettings(settings);
    const feeType = type === 'physical' ? 'physical' : 'digital';
    let normalFee: { type: string; mode: 'percentage' | 'fixed'; value: number; fixedAmountInCurrency: number | null; currency: string | null; source: 'platform_fees' | 'commission_rules' } | null = null;
    try {
      const fees: any = await this.adminConfig.getPlatformFees();
      const rule = fees?.[feeType];
      if (rule) {
        let converted: number | null = null;
        if (rule.mode === 'fixed') {
          const cur = currency === 'PKR' ? 'PKR' : 'USD';
          if (cur === 'USD') converted = rule.value;
          else { const rate = await this.pkrRate(); converted = rate ? Math.round(rule.value * rate) : null; }
          normalFee = { type: feeType, mode: 'fixed', value: rule.value, fixedAmountInCurrency: converted, currency: cur, source: 'platform_fees' };
        } else {
          normalFee = { type: feeType, mode: 'percentage', value: rule.value, fixedAmountInCurrency: null, currency: null, source: 'platform_fees' };
        }
      }
    } catch { /* terms still useful without the normal fee */ }
    if (!normalFee && this.commissionRules && typeof storeId === 'string' && isValidObjectId(storeId)) {
      try {
        const { rate, source } = await this.commissionRules.resolveRate(storeId);
        // 'hardcoded_fallback' with 0 = no rule exists at all: the fee is NOT set, never present it as 0%.
        if (source !== 'hardcoded_fallback' || rate > 0) {
          normalFee = { type: feeType, mode: 'percentage', value: Math.round(rate * 10000) / 100, fixedAmountInCurrency: null, currency: null, source: 'commission_rules' };
        }
      } catch { /* leave null */ }
    }
    return {
      success: true,
      data: {
        platformDiscount: { enabled: t.platformEnabled, percent: t.platformPercent },
        platformPercent: t.platformPercent,
        premiumSellerFeePercent: t.sellerFeePercent,
        minGapPercent: t.minGapPercent,
        normalFee,
      },
    };
  }

  /** Seller: this store's products whose normal sale is too close to (or above) their Premium discount. Warning only - never blocks. */
  async sellerPremiumConflicts(sellerId: string, storeId: string) {
    if (!isValidObjectId(storeId)) throw new NotFoundException('Store not found');
    const repos = this.db.repositories;
    const store: any = await repos.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('premiumDiscount').lean();
    if (!store) throw new NotFoundException('Store not found');
    const gap = termsFromSettings(await this.entitlements.getSettings()).minGapPercent;
    const products: any[] = await repos.productModel.find({ storeId, isDelete: false, status: { $ne: 'inactive' } }).select('name premiumDiscountPercent premiumOptOut campaignIds').limit(2000).lean();
    const variants: any[] = products.length
      ? await repos.productVariantModel.find({ productId: { $in: products.map((p) => String(p._id)) }, isDelete: false, status: 'active' }).select('productId price compareAtPrice').lean()
      : [];
    const byProduct = new Map<string, any[]>();
    for (const v of variants) { const k = String(v.productId); if (!byProduct.has(k)) byProduct.set(k, []); byProduct.get(k)!.push(v); }
    const conflicts: Array<{ productId: string; name: string; premiumPercent: number; salePercent: number; message: string }> = [];
    const bothOffers: Array<{ productId: string; name: string; premiumPercent: number }> = [];
    for (const p of products) {
      const pct = premiumPercentFor(p, store);
      // legacy data: a product that has a Premium offer AND is ticked for a platform sale (they are exclusive now)
      if (pct > 0 && Array.isArray(p.campaignIds) && p.campaignIds.length > 0) bothOffers.push({ productId: String(p._id), name: p.name, premiumPercent: pct });
      const vs = byProduct.get(String(p._id)) ?? [];
      const message = premiumGapViolation(pct, vs, gap);
      if (message) conflicts.push({ productId: String(p._id), name: p.name, premiumPercent: pct, salePercent: Math.round(Math.max(...vs.map((v) => normalSalePercent(v.price, v.compareAtPrice))) * 10) / 10, message });
    }
    return { success: true, data: { minGapPercent: gap, conflicts, bothOffers } };
  }

  // ── plans ────────────────────────────────────────────────────────────────

  async listPublicPlans() {
    const plans = await this.planModel.find({ isActive: true, isDelete: { $ne: true } }).sort({ sortOrder: 1, monthlyPriceUSD: 1 }).lean();
    const rate = await this.pkrRate();
    return { success: true, data: plans.map((p) => this.presentPlan(p, rate)) };
  }

  async adminListPlans() {
    const plans = await this.planModel.find({ isDelete: { $ne: true } }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    const rate = await this.pkrRate();
    const counts = await this.membershipModel.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$planId', n: { $sum: 1 } } }]);
    const byPlan = new Map<string, number>(counts.map((c: any) => [String(c._id), c.n]));
    return { success: true, data: plans.map((p) => ({ ...this.presentPlan(p, rate), activeMembers: byPlan.get(String(p._id)) ?? 0 })) };
  }

  async adminCreatePlan(adminId: string, dto: CreatePremiumPlanDto) {
    if (dto.yearlyPriceUSD != null && dto.yearlyPriceUSD < 0) throw new BadRequestException('yearlyPriceUSD must be >= 0');
    const plan = await this.planModel.create({
      name: dto.name.trim(), description: dto.description?.trim() ?? '',
      monthlyPriceUSD: dto.monthlyPriceUSD, yearlyPriceUSD: dto.yearlyPriceUSD ?? null,
      isActive: dto.isActive ?? true, sortOrder: dto.sortOrder ?? 0,
      benefits: this.benefitsOf({ ...DEFAULT_BENEFITS, ...(dto.benefits ?? {}) }),
    });
    await this.audit(adminId, 'premium_plan_created', `Created Premium plan "${plan.name}"`, String(plan._id), 'premium_plan');
    return { success: true, data: this.presentPlan(plan.toObject(), await this.pkrRate()) };
  }

  async adminUpdatePlan(adminId: string, id: string, dto: UpdatePremiumPlanDto) {
    if (!isValidObjectId(id)) throw new NotFoundException('Plan not found');
    const existing: any = await this.planModel.findOne({ _id: id, isDelete: { $ne: true } }).lean();
    if (!existing) throw new NotFoundException('Plan not found');
    const $set: Record<string, any> = {};
    if (dto.name !== undefined) $set.name = dto.name.trim();
    if (dto.description !== undefined) $set.description = dto.description.trim();
    if (dto.monthlyPriceUSD !== undefined) $set.monthlyPriceUSD = dto.monthlyPriceUSD;
    if (dto.yearlyPriceUSD !== undefined) $set.yearlyPriceUSD = dto.yearlyPriceUSD;
    if (dto.isActive !== undefined) $set.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) $set.sortOrder = dto.sortOrder;
    if (dto.benefits) $set.benefits = this.benefitsOf({ ...this.benefitsOf(existing.benefits), ...dto.benefits });
    const plan = await this.planModel.findByIdAndUpdate(id, { $set }, { returnDocument: 'after' }).lean();
    await this.audit(adminId, 'premium_plan_updated', `Updated Premium plan "${(plan as any).name}"`, id, 'premium_plan', { fields: Object.keys($set) });
    // Running memberships keep their purchase-time snapshot; only new purchases / renewals pick up new benefits.
    return { success: true, data: this.presentPlan(plan, await this.pkrRate()) };
  }

  async adminDeletePlan(adminId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Plan not found');
    const plan = await this.planModel.findOneAndUpdate({ _id: id, isDelete: { $ne: true } }, { $set: { isDelete: true, isActive: false } }, { returnDocument: 'after' }).lean();
    if (!plan) throw new NotFoundException('Plan not found');
    await this.audit(adminId, 'premium_plan_archived', `Archived Premium plan "${(plan as any).name}"`, id, 'premium_plan');
    return { success: true, message: 'Plan archived (existing members keep their benefits until their period ends).' };
  }

  // ── buyer: membership ────────────────────────────────────────────────────

  async me(userId: string) {
    const now = new Date();
    const [m, ent, coupon, pending] = await Promise.all([
      this.membershipModel.findOne({ userId }).lean() as any,
      this.entitlements.getEntitlements(userId),
      this.currentCoupon(userId, now),
      this.paymentModel.findOne({ userId, status: { $in: ['awaiting_proof', 'pending', 'rejected'] } }).sort({ createdAt: -1 }).lean() as any,
    ]);
    const live = !!m && m.status === 'active' && m.currentPeriodEnd && new Date(m.currentPeriodEnd) > now;
    const membership = m ? {
      status: live ? 'active' : m.status === 'active' ? 'expired' : m.status,
      planId: m.planId, planName: m.planSnapshot?.name ?? null, benefits: m.planSnapshot ? this.benefitsOf(m.planSnapshot.benefits) : null,
      interval: m.interval, startedAt: m.startedAt, currentPeriodEnd: m.currentPeriodEnd,
      daysLeft: live ? Math.max(0, Math.ceil((new Date(m.currentPeriodEnd).getTime() - now.getTime()) / DAY)) : 0,
      cancelAtPeriodEnd: !!m.cancelAtPeriodEnd, source: m.source,
    } : null;
    return { success: true, data: { isPremium: ent.isPremium, entitlements: ent, membership, coupon, pendingPayment: pending ? this.presentPayment(pending) : null } };
  }

  private async currentCoupon(userId: string, now: Date) {
    const issue: any = await this.couponIssueModel.findOne({ userId, month: monthKey(now) }).lean();
    if (!issue) return null;
    const c: any = await this.db.repositories.couponModel.findOne({ code: issue.code, scope: 'platform' }).select('discountType discountValue usageCount expiresAt isActive').lean();
    if (!c) return null;
    return { code: issue.code, discountType: c.discountType, discountValue: c.discountValue, currency: c.discountType === 'fixed' ? 'USD' : null, expiresAt: c.expiresAt, used: (c.usageCount ?? 0) > 0, expired: !!c.expiresAt && new Date(c.expiresAt) < now };
  }

  /** The platform account the buyer pays into (same source as checkout's bank transfer). */
  async getBankDetails() {
    const dp: any = await this.adminConfig.getPlatformTransferDetails();
    if (!dp) throw new BadRequestException('Bank transfer is not available right now - please try again later.');
    return {
      payeeName: dp.accountTitle ?? 'Edudeen', bankName: dp.bankName ?? null, accountTitle: dp.accountTitle ?? null,
      accountNumber: dp.accountNumber ?? null, iban: dp.iban ?? null, jazzcashNumber: dp.jazzcashNumber ?? null,
      easypaisaNumber: dp.easypaisaNumber ?? null, instructions: dp.instructions ?? null, usdToPkrRate: dp.usdToPkrRate ?? 0,
    };
  }

  /** Step 1: creates (or refreshes) the buyer's pending purchase. Step 2 (POST payments/:id/proof) uploads the transfer proof. */
  async subscribe(userId: string, dto: SubscribePremiumDto) {
    const plan: any = isValidObjectId(dto.planId) ? await this.planModel.findOne({ _id: dto.planId, isActive: true, isDelete: { $ne: true } }).lean() : null;
    if (!plan) throw new NotFoundException('That Premium plan is not available');
    const bankDetails = await this.getBankDetails();
    const open: any = await this.paymentModel.findOne({ userId, status: 'pending' }).lean();
    if (open) throw new BadRequestException('You already have a Premium payment under review - we will notify you once it is confirmed.');

    const amountUSD = this.priceUSD(plan, dto.interval);
    const rate = await this.pkrRate();
    if (!rate) throw new BadRequestException('PKR pricing is temporarily unavailable - please try again shortly.');
    const amountPKR = Math.round(amountUSD * rate);

    // One open "awaiting proof" purchase per buyer: re-subscribing just refreshes it.
    const existing = await this.paymentModel.findOne({ userId, status: 'awaiting_proof' });
    const payment = existing
      ? Object.assign(existing, { planId: String(plan._id), planName: plan.name, interval: dto.interval, amountUSD, amountPKR, fxRateUsed: rate })
      : new this.paymentModel({ userId, planId: String(plan._id), planName: plan.name, interval: dto.interval, amountUSD, amountPKR, fxRateUsed: rate, status: 'awaiting_proof' });
    await payment.save();

    // A first-time buyer gets a visible 'pending' membership row (never granting any benefit - entitlements need status 'active').
    await this.membershipModel.updateOne(
      { userId },
      { $setOnInsert: { userId, planId: String(plan._id), status: 'pending', interval: dto.interval, source: 'bank_transfer' } },
      { upsert: true },
    ).catch(() => undefined);

    return { success: true, message: 'Transfer the amount below, then upload your proof.', data: { payment: this.presentPayment(payment), bankDetails } };
  }

  async submitProof(userId: string, paymentId: string, dto: SubmitPremiumProofDto, file: Express.Multer.File | undefined) {
    if (!isValidObjectId(paymentId)) throw new NotFoundException('Payment not found');
    const p = await this.paymentModel.findOne({ _id: paymentId, userId });
    if (!p) throw new NotFoundException('Payment not found');
    if (p.status !== 'awaiting_proof' && p.status !== 'rejected') throw new BadRequestException(`Cannot upload proof - this payment is "${p.status}"`);
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');
    assertProofFile(file);
    const upload = await this.uploadService.uploadPrivateFile(file, PROOF_FOLDER);
    if (p.status === 'rejected') p.reuploadCount = (p.reuploadCount ?? 0) + 1;
    p.proofPublicId = upload.publicId; p.proofResourceType = upload.resourceType;
    p.transactionReference = dto.transactionReference ?? p.transactionReference; p.senderName = dto.senderName ?? p.senderName;
    p.status = 'pending'; p.rejectionReason = null; p.reviewedByAdminId = null; p.reviewedAt = null;
    await p.save();
    void this.notifyUser(userId, NOTIFICATION_TYPES.PREMIUM_PAYMENT_SUBMITTED, 'Premium payment proof received',
      `We received your transfer proof for PKR ${p.amountPKR} - we are verifying it now.`, { link: '/account/premium', paymentId: String(p._id) });
    return { success: true, message: "We're verifying your payment - you'll be notified once it's confirmed.", data: this.presentPayment(p) };
  }

  async myPayments(userId: string) {
    const rows = await this.paymentModel.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
    return { success: true, data: rows.map((r) => this.presentPayment(r)) };
  }

  /** Stops renewal reminders and lets the membership lapse at the end of the paid period (benefits stay until then). */
  async cancel(userId: string) {
    const r = await this.membershipModel.findOneAndUpdate(
      { userId, status: 'active', currentPeriodEnd: { $gt: new Date() } }, { $set: { cancelAtPeriodEnd: true } }, { returnDocument: 'after' }).lean();
    if (!r) throw new BadRequestException('You do not have an active Premium membership');
    await this.entitlements.invalidate(userId);
    return { success: true, message: 'Your membership will not renew. Benefits stay until the end of your paid period.', data: { currentPeriodEnd: (r as any).currentPeriodEnd, cancelAtPeriodEnd: true } };
  }

  async resume(userId: string) {
    const r = await this.membershipModel.findOneAndUpdate(
      { userId, status: 'active', currentPeriodEnd: { $gt: new Date() } }, { $set: { cancelAtPeriodEnd: false } }, { returnDocument: 'after' }).lean();
    if (!r) throw new BadRequestException('You do not have an active Premium membership');
    return { success: true, data: { currentPeriodEnd: (r as any).currentPeriodEnd, cancelAtPeriodEnd: false } };
  }

  // ── activation (shared by approval and admin grant) ─────────────────────

  /** Makes the membership active; extends from the current period end when still running. */
  async activate(userId: string, plan: any, interval: 'monthly' | 'yearly', source: 'bank_transfer' | 'admin_grant' | 'stripe', days?: number) {
    const now = new Date();
    const existing: any = await this.membershipModel.findOne({ userId }).lean();
    const running = !!existing && existing.status === 'active' && existing.currentPeriodEnd && new Date(existing.currentPeriodEnd) > now;
    const base = running ? new Date(existing.currentPeriodEnd) : now;
    const end = days ? new Date(base.getTime() + days * DAY) : addPeriod(base, interval);
    const planSnapshot = { name: plan.name, benefits: this.benefitsOf(plan.benefits) };
    const m: any = await this.membershipModel.findOneAndUpdate(
      { userId },
      { $set: { planId: String(plan._id), planSnapshot, status: 'active', interval, startedAt: running && existing.startedAt ? existing.startedAt : now, currentPeriodEnd: end, source, cancelAtPeriodEnd: false, expiringNotifiedFor: null, expiredNotifiedAt: null } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    await this.entitlements.invalidate(userId);
    await this.issueMonthlyCoupon(userId, m, now).catch((e) => this.logger.warn(`coupon on activation failed: ${e?.message}`));
    return m;
  }

  // ── admin: members, grant / revoke ───────────────────────────────────────

  async adminListMembers(query: any) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, clampInt(query.limit, 20, 1, 100));
    const filter: Record<string, any> = {};
    const now = new Date();
    if (query.status === 'active') { filter.status = 'active'; filter.currentPeriodEnd = { $gt: now }; }
    else if (query.status === 'expiring') { filter.status = 'active'; filter.currentPeriodEnd = { $gt: now, $lte: new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY) }; }
    else if (['expired', 'cancelled', 'pending'].includes(query.status)) filter.status = query.status;
    if (['bank_transfer', 'admin_grant', 'stripe'].includes(query.source)) filter.source = query.source;
    if (typeof query.q === 'string' && query.q.trim()) {
      const rx = new RegExp(escapeRegex(query.q.trim().slice(0, 80)), 'i');
      const users: any[] = await this.db.repositories.userModel.find({ $or: [{ name: rx }, { email: rx }] }).select('_id').limit(200).lean();
      filter.userId = { $in: users.map((u) => String(u._id)) };
    }
    const [rows, total] = await Promise.all([
      this.membershipModel.find(filter).sort({ currentPeriodEnd: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.membershipModel.countDocuments(filter),
    ]);
    const users: any[] = await this.db.repositories.userModel.find({ _id: { $in: rows.map((r: any) => r.userId) } }).select('name email').lean();
    const um = new Map(users.map((u) => [String(u._id), u]));
    return {
      success: true,
      data: {
        members: rows.map((r: any) => ({ ...r, planName: r.planSnapshot?.name ?? null, userName: um.get(r.userId)?.name ?? null, userEmail: um.get(r.userId)?.email ?? null, isLive: r.status === 'active' && new Date(r.currentPeriodEnd) > now })),
        total, page, limit, pages: Math.ceil(total / limit),
      },
    };
  }

  async adminGrant(adminId: string, dto: GrantPremiumDto) {
    let user: any = null;
    if (dto.userId && isValidObjectId(dto.userId)) user = await this.db.repositories.userModel.findOne({ _id: dto.userId, isDelete: false }).select('name email').lean();
    else if (dto.email) user = await this.db.repositories.userModel.findOne({ email: dto.email.trim().toLowerCase(), isDelete: false }).select('name email').lean();
    if (!user) throw new NotFoundException('Buyer account not found');
    const plan: any = await this.planModel.findOne({ _id: dto.planId, isDelete: { $ne: true } }).lean();
    if (!plan) throw new NotFoundException('Plan not found');
    const m = await this.activate(String(user._id), plan, dto.days >= 365 ? 'yearly' : 'monthly', 'admin_grant', dto.days);
    await this.audit(adminId, 'premium_granted', `Granted Premium (${dto.days} days) to ${user.email}`, String(user._id), 'premium_membership', { planId: dto.planId, days: dto.days });
    void this.notifyUser(String(user._id), NOTIFICATION_TYPES.PREMIUM_ACTIVATED, 'Edudeen Premium is active', `Your Premium membership is active until ${new Date(m.currentPeriodEnd).toDateString()}.`, { link: '/account/premium' });
    return { success: true, data: m };
  }

  async adminRevoke(adminId: string, userId: string, reason?: string) {
    if (!isValidObjectId(userId)) throw new NotFoundException('Membership not found');
    const m = await this.membershipModel.findOneAndUpdate({ userId, status: 'active' }, { $set: { status: 'cancelled', currentPeriodEnd: new Date(), cancelAtPeriodEnd: false } }, { returnDocument: 'after' }).lean();
    if (!m) throw new NotFoundException('No active membership for this buyer');
    await this.entitlements.invalidate(userId);
    await this.audit(adminId, 'premium_revoked', `Revoked Premium${reason ? `: ${reason}` : ''}`, userId, 'premium_membership', { reason: reason ?? null });
    void this.notifyUser(userId, NOTIFICATION_TYPES.PREMIUM_EXPIRED, 'Your Edudeen Premium ended', reason ? `Reason: ${reason}` : 'Your Premium membership has been ended by the Edudeen team.', { link: '/account/premium' });
    return { success: true, data: m };
  }

  // ── admin: payment proofs ────────────────────────────────────────────────

  async adminListPayments(query: any) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, clampInt(query.limit, 20, 1, 100));
    const filter: Record<string, any> = {};
    if (['awaiting_proof', 'pending', 'approved', 'rejected', 'cancelled'].includes(query.status)) filter.status = query.status;
    const [rows, total] = await Promise.all([
      this.paymentModel.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.paymentModel.countDocuments(filter),
    ]);
    const users: any[] = await this.db.repositories.userModel.find({ _id: { $in: rows.map((r: any) => r.userId) } }).select('name email').lean();
    const um = new Map(users.map((u) => [String(u._id), u]));
    return { success: true, data: { payments: rows.map((r: any) => ({ ...this.presentPayment(r), buyerName: um.get(r.userId)?.name ?? 'Unknown buyer', buyerEmail: um.get(r.userId)?.email ?? '' })), total, page, limit, pages: Math.ceil(total / limit) } };
  }

  async adminProofUrl(id: string) {
    const p: any = isValidObjectId(id) ? await this.paymentModel.findById(id).lean() : null;
    if (!p) throw new NotFoundException('Payment not found');
    return { success: true, data: { url: this.proofUrl(p), expiresInSeconds: PROOF_URL_TTL_SECONDS } };
  }

  async adminApprove(adminId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Payment not found');
    // Claim first so two admins (or a retry) can never extend the membership twice.
    const claimed: any = await this.paymentModel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'approved', reviewedByAdminId: adminId, reviewedAt: new Date() } }, { returnDocument: 'after' }).lean();
    if (!claimed) {
      const ex: any = await this.paymentModel.findById(id).select('status').lean();
      if (!ex) throw new NotFoundException('Payment not found');
      throw new BadRequestException(`Cannot approve a payment with status "${ex.status}"`);
    }
    try {
      const plan: any = await this.planModel.findById(claimed.planId).lean();
      if (!plan) throw new Error('plan missing');
      const m = await this.activate(claimed.userId, plan, claimed.interval, 'bank_transfer');
      await this.audit(adminId, 'premium_payment_approved', `Approved Premium payment (${claimed.interval}, $${claimed.amountUSD})`, id, 'premium_payment', { userId: claimed.userId });
      void this.notifyUser(claimed.userId, NOTIFICATION_TYPES.PREMIUM_ACTIVATED, 'Edudeen Premium is active',
        `Welcome to Premium! Your membership is active until ${new Date(m.currentPeriodEnd).toDateString()}.`, { link: '/account/premium' },
        notificationEmailShell('Welcome to Edudeen Premium', `<p>Your payment is confirmed. Your membership is active until <strong>${escapeHtml(new Date(m.currentPeriodEnd).toDateString())}</strong>.</p>`, { label: 'See my benefits', url: `${WEB()}/account/premium` }));
      return { success: true, data: { payment: this.presentPayment(claimed), membership: m } };
    } catch (err: any) {
      await this.paymentModel.updateOne({ _id: id, status: 'approved' }, { $set: { status: 'pending', reviewedByAdminId: null, reviewedAt: null } }); // release: retry later
      this.logger.error(`premium approval ${id} failed: ${err?.message}`);
      throw new BadRequestException('Could not activate the membership - the payment is back in the queue, please retry.');
    }
  }

  async adminReject(adminId: string, id: string, reason: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Payment not found');
    const p: any = await this.paymentModel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'rejected', reviewedByAdminId: adminId, reviewedAt: new Date(), rejectionReason: reason } }, { returnDocument: 'after' }).lean();
    if (!p) throw new BadRequestException('Only a payment under review can be rejected');
    await this.audit(adminId, 'premium_payment_rejected', `Rejected Premium payment: ${reason}`, id, 'premium_payment', { userId: p.userId });
    void this.notifyUser(p.userId, NOTIFICATION_TYPES.PREMIUM_PAYMENT_REJECTED, 'Premium payment not confirmed', `We could not confirm your transfer: ${reason}. You can upload a new proof.`, { link: '/account/premium', paymentId: id });
    return { success: true, data: this.presentPayment(p) };
  }

  // ── admin: stats ─────────────────────────────────────────────────────────

  async adminStats() {
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * DAY);
    const orderModel = this.db.repositories.orderModel;
    const [active, expiring, expired, pendingPayments, revenue, revenue30, byInterval, premiumOrders] = await Promise.all([
      this.membershipModel.countDocuments({ status: 'active', currentPeriodEnd: { $gt: now } }),
      this.membershipModel.countDocuments({ status: 'active', currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY) } }),
      this.membershipModel.countDocuments({ status: { $in: ['expired', 'cancelled'] } }),
      this.paymentModel.countDocuments({ status: 'pending' }),
      this.paymentModel.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, usd: { $sum: '$amountUSD' }, n: { $sum: 1 } } }]),
      this.paymentModel.aggregate([{ $match: { status: 'approved', reviewedAt: { $gte: since30 } } }, { $group: { _id: null, usd: { $sum: '$amountUSD' }, n: { $sum: 1 } } }]),
      this.membershipModel.aggregate([{ $match: { status: 'active', currentPeriodEnd: { $gt: now } } }, { $group: { _id: '$interval', n: { $sum: 1 } } }]),
      orderModel.aggregate([{ $match: { isPremiumOrder: true, isDelete: false } }, { $group: { _id: '$currency', orders: { $sum: 1 }, premiumDiscount: { $sum: '$premiumDiscountTotal' }, platformPremiumDiscount: { $sum: '$premiumPlatformDiscountTotal' }, revenue: { $sum: '$totalAmount' } } }]),
    ]);
    return {
      success: true,
      data: {
        activeMembers: active, expiringIn3Days: expiring, lapsedMembers: expired, pendingPayments,
        revenueUSD: round2(revenue[0]?.usd ?? 0), approvedPayments: revenue[0]?.n ?? 0,
        revenueLast30DaysUSD: round2(revenue30[0]?.usd ?? 0),
        activeByInterval: { monthly: byInterval.find((b: any) => b._id === 'monthly')?.n ?? 0, yearly: byInterval.find((b: any) => b._id === 'yearly')?.n ?? 0 },
        // Seller-funded member-price discount given on Premium orders, per order currency.
        premiumOrders: premiumOrders.map((o: any) => ({ currency: o._id, orders: o.orders, premiumDiscount: round2(o.premiumDiscount), platformFundedPremiumDiscount: round2(o.platformPremiumDiscount ?? 0), orderTotal: round2(o.revenue) })),
      },
    };
  }

  // ── cron ─────────────────────────────────────────────────────────────────

  @Cron('*/30 * * * *')
  async cronMembershipLifecycle() {
    await this.locked('premium-lifecycle', 25 * 60_000, async () => { await this.runLifecycle(); });
  }

  async runLifecycle(now = new Date()): Promise<{ expired: number; reminded: number }> {
    let expired = 0;
    let reminded = 0;
    // 1) expire
    const due: any[] = await this.membershipModel.find({ status: 'active', currentPeriodEnd: { $lte: now } }).limit(500).lean();
    for (const m of due) {
      const next = m.cancelAtPeriodEnd ? 'cancelled' : 'expired';
      const won = await this.membershipModel.findOneAndUpdate({ _id: m._id, status: 'active', currentPeriodEnd: { $lte: now } }, { $set: { status: next, expiredNotifiedAt: now } });
      if (!won) continue;
      expired++;
      await this.entitlements.invalidate(m.userId);
      void this.notifyUser(m.userId, NOTIFICATION_TYPES.PREMIUM_EXPIRED, 'Your Edudeen Premium has ended',
        'Your membership period is over. Renew any time to get your member benefits back.', { link: '/account/premium' },
        notificationEmailShell('Your Premium membership has ended', '<p>Your Edudeen Premium period is over. Renew any time to get your member benefits back.</p>', { label: 'Renew Premium', url: `${WEB()}/account/premium` }));
    }
    // 2) expiring in <= 3 days (once per period)
    const soon: any[] = await this.membershipModel.find({ status: 'active', currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY) } }).limit(1000).lean();
    for (const m of soon) {
      if (m.expiringNotifiedFor && new Date(m.expiringNotifiedFor).getTime() === new Date(m.currentPeriodEnd).getTime()) continue;
      const won = await this.membershipModel.findOneAndUpdate({ _id: m._id, status: 'active', expiringNotifiedFor: m.expiringNotifiedFor ?? null }, { $set: { expiringNotifiedFor: m.currentPeriodEnd } });
      if (!won) continue;
      reminded++;
      const when = new Date(m.currentPeriodEnd).toDateString();
      void this.notifyUser(m.userId, NOTIFICATION_TYPES.PREMIUM_EXPIRING_SOON, 'Your Premium ends soon',
        m.cancelAtPeriodEnd ? `Your membership ends on ${when}.` : `Your membership ends on ${when}. Renew to keep your benefits.`, { link: '/account/premium' },
        notificationEmailShell('Your Premium ends soon', `<p>Your Edudeen Premium ends on <strong>${escapeHtml(when)}</strong>. Renew to keep your member benefits.</p>`, { label: 'Renew Premium', url: `${WEB()}/account/premium` }));
    }
    return { expired, reminded };
  }

  @Cron('15 3 * * *')
  async cronMonthlyCoupons() {
    await this.locked('premium-monthly-coupons', 50 * 60_000, async () => { await this.runMonthlyCoupons(); });
  }

  /** Once per calendar month per active member (the unique ledger row makes it idempotent across instances/retries). */
  async runMonthlyCoupons(now = new Date()): Promise<{ issued: number }> {
    let issued = 0;
    let lastId: string | null = null;
    for (;;) {
      const batch: any[] = await this.membershipModel
        .find({ status: 'active', currentPeriodEnd: { $gt: now }, ...(lastId ? { _id: { $gt: lastId } } : {}) })
        .sort({ _id: 1 }).limit(200).lean();
      if (!batch.length) break;
      for (const m of batch) {
        try { if (await this.issueMonthlyCoupon(m.userId, m, now)) issued++; }
        catch (err: any) { this.logger.warn(`monthly coupon for ${m.userId} failed: ${err?.message}`); }
      }
      lastId = String(batch[batch.length - 1]._id);
    }
    return { issued };
  }

  /**
   * Personal single-use PLATFORM-FUNDED coupon (Coupon.platformFunded + ownerUserId): at checkout its discount is tagged
   * couponSponsorType 'platform', so the seller is credited the full price (see PaymentService.buildSellerOrders).
   */
  async issueMonthlyCoupon(userId: string, membership: any, now = new Date()): Promise<string | null> {
    const b = this.benefitsOf(membership?.planSnapshot?.benefits);
    if (!(b.monthlyCouponValue > 0)) return null;
    const month = monthKey(now);
    const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1);
    const expiresAt = new Date(Math.max(endOfMonth.getTime(), now.getTime() + 14 * DAY));
    let code = '';
    try {
      code = `PRM${randomBytes(4).toString('hex').toUpperCase()}`;
      await this.couponIssueModel.create({ userId, month, code, expiresAt });
    } catch (err: any) {
      if (err?.code === 11000) return null; // already issued this month
      throw err;
    }
    try {
      await this.db.repositories.couponModel.create({
        scope: 'platform', adminId: null, code, discountType: b.monthlyCouponType, discountValue: b.monthlyCouponValue,
        currency: b.monthlyCouponType === 'fixed' ? 'USD' : null, minOrderAmount: null, usageLimit: 1, expiresAt,
        ownerUserId: userId, platformFunded: true,
      });
    } catch (err: any) {
      await this.couponIssueModel.deleteOne({ userId, month }); // let the next run retry with a fresh code
      throw err;
    }
    const label = b.monthlyCouponType === 'percentage' ? `${b.monthlyCouponValue}% off` : `$${b.monthlyCouponValue} off`;
    void this.notifyUser(userId, NOTIFICATION_TYPES.PREMIUM_COUPON, 'Your monthly Premium coupon',
      `Use code ${code} at checkout for ${label}. Valid until ${expiresAt.toDateString()}, single use.`, { link: '/cart', code },
      notificationEmailShell('Your monthly Premium coupon', `<p>Use code <strong>${escapeHtml(code)}</strong> at checkout for <strong>${escapeHtml(label)}</strong>. It is valid until ${escapeHtml(expiresAt.toDateString())} and works once.</p>`, { label: 'Go to my cart', url: `${WEB()}/cart` }));
    return code;
  }
}
