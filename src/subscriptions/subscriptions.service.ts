/* eslint-disable prettier/prettier */
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, ConflictException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ClientSession } from 'mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { CurrencyDisplayService } from './currency-display.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SubscriptionNotificationsService } from './subscription-notifications.service';
import { SubscriptionBenefitsService } from './subscription-benefits.service';
import { FinanceService } from 'src/finance/finance.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { PlanBenefitDto } from './dto/plan-benefit.dto';
import { QUEUE_NAMES, SUBSCRIPTION_EMAIL_JOB } from 'src/queues/queue.constants';
import type { SubscriptionNotificationPreference } from './schemas/subscription-notification-preference.schema';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';

// Dunning: how many consecutive renewal-charge failures before we give up
// and cancel the subscription, and how long to wait before each retry.
const MAX_RENEWAL_ATTEMPTS = 3;
const RETRY_INTERVAL_DAYS = 1;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  // Platform's cut of subscription revenue. Previously subscription revenue
  // was 100% retained by the platform with no seller payout at all (a
  // business-model gap, not a deliberate policy) — this brings it in line
  // with how order revenue already works (see FinanceService.recordSale's
  // PLATFORM_FEE_RATE), just at a higher rate to reflect that Edudeen runs
  // the entire billing/dunning/hosting engine for this revenue stream.
  private readonly platformCommissionRate: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly currency: CurrencyDisplayService,
    private readonly activityLogService: ActivityLogService,
    private readonly notifications: SubscriptionNotificationsService,
    private readonly benefitsService: SubscriptionBenefitsService,
    private readonly financeService: FinanceService,
    private readonly entitlementsService: EntitlementsService,
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
    @InjectConnection() private readonly connection: Connection,
    @InjectQueue(QUEUE_NAMES.SUBSCRIPTION_EMAILS) private readonly emailQueue: Queue,
    @InjectQueue(QUEUE_NAMES.STRIPE_WEBHOOKS) private readonly webhookQueue: Queue,
  ) {
    this.platformCommissionRate = Number(this.config.get<string>('SUBSCRIPTION_PLATFORM_COMMISSION_RATE') ?? '0.20');
  }

  // ── Shorthand getters ────────────────────────────────────────────────────
  private get planModel()    { return this.db.repositories.subscriptionPlanModel; }
  private get subModel()     { return this.db.repositories.subscriptionModel; }
  private get invoiceModel() { return this.db.repositories.subscriptionInvoiceModel; }
  private get attemptModel() { return this.db.repositories.subscriptionPaymentAttemptModel; }
  private get storeModel()   { return this.db.repositories.storeModel; }
  private get counterModel() { return this.db.repositories.subscriptionCounterModel; }
  private get creditWalletModel() { return this.db.repositories.subscriptionCreditWalletModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private round(n: number) { return Math.round(n * 100) / 100; }

  /**
   * Atomic, collision-proof invoice numbering — replaces the previous
   * random-suffix generator (`INV-YYYYMM-<random6>`), which relied on the
   * DB's unique index to *detect* a collision rather than making one
   * structurally impossible, and threw a raw Mongo E11000 error up through
   * the billing flow on the rare occasions it collided.
   */
  private async generateInvoiceNumber(): Promise<string> {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const key = `invoice-${y}${m}`;
    const counter = await this.counterModel.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    return `INV-${y}${m}-${String(counter.seq).padStart(6, '0')}`;
  }

  // Maps a notification "kind" (SubscriptionNotificationsService method name)
  // to the buyer preference flag that gates it. Payment-failed/cancellation
  // emails are billing-critical and intentionally NOT gated by preference —
  // a buyer can turn off reminders/marketing but not silence "your card was
  // declined" or "your subscription was canceled".
  private static readonly EMAIL_PREFERENCE_MAP: Record<string, keyof SubscriptionNotificationPreference> = {
    sendRenewalReminder: 'renewalReminders',
    sendProrationCharged: 'prorationReceipts',
    sendProrationCredited: 'prorationReceipts',
  };

  private async isNotificationAllowed(customerId: string, kind: string): Promise<boolean> {
    const prefKey = SubscriptionsService.EMAIL_PREFERENCE_MAP[kind];
    if (!prefKey) return true; // not gated — always send
    const prefs = await this.db.repositories.subscriptionNotificationPreferenceModel.findOne({ customerId }).lean();
    if (!prefs) return true; // no record yet == defaults == everything on
    return (prefs as any)[prefKey] !== false;
  }

  /** Queues a subscription email instead of sending it inline — keeps SMTP latency off the request/cron hot path and gives durable retry via BullMQ. */
  private async queueEmail(kind: string, to: string, data: Record<string, any>, customerId?: string) {
    if (customerId && !(await this.isNotificationAllowed(customerId, kind))) return;
    try {
      await this.emailQueue.add(SUBSCRIPTION_EMAIL_JOB, { kind, to, data });
    } catch (err: any) {
      // If Redis/BullMQ is unavailable, fall back to sending inline rather than
      // silently dropping a billing-critical notification.
      this.logger.warn(`Email queue unavailable (${err?.message}) — sending "${kind}" inline`);
      await (this.notifications as any)[kind]?.(to, data);
    }
  }

  private addPeriod(date: Date, interval: 'monthly' | 'yearly'): Date {
    const d = new Date(date);
    if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // Monthly recurring revenue contribution of a single active subscription
  private toMrrContribution(amountUSD: number, interval: string): number {
    return interval === 'monthly' ? amountUSD : this.round(amountUSD / 12);
  }

  /** Same ownership pattern as FinanceService.verifyStoreOwnership. */
  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    return verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
  }

  private async verifyPlanInStore(storeId: string, planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, storeId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    return plan;
  }

  private async verifySubInStore(storeId: string, subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, storeId, isDelete: false });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  private async verifyMySub(customerId: string, subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, customerId, isDelete: false });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  private pendingCancellation(sub: any): boolean {
    return sub.status === 'active' && !!sub.canceledAt;
  }

  private async getCustomerAndStoreNames(customerId: string, storeId: string) {
    const [customer, store] = await Promise.all([
      this.db.repositories.userModel.findById(customerId).select('name email').lean(),
      this.storeModel.findById(storeId).select('name').lean(),
    ]);
    return {
      customerName: (customer as any)?.name ?? 'there',
      customerEmail: (customer as any)?.email ?? null,
      storeName: (store as any)?.name ?? 'the store',
    };
  }

  /** Records one row in the dunning/retry audit trail. Never throws — logging must not break billing. */
  private async recordPaymentAttempt(params: {
    subscriptionId: string; storeId: string; sellerId: string; customerId: string;
    attemptType: 'initial' | 'renewal' | 'proration';
    outcome: 'success' | 'failed';
    amountUSD: number;
    failureReason?: string | null;
    failureCode?: string | null;
    invoiceId?: string | null;
    providerChargeId?: string | null;
    stripePaymentIntentId?: string | null;
  }, session?: ClientSession) {
    try {
      const attemptNumber = (await this.attemptModel.countDocuments({ subscriptionId: params.subscriptionId }).session(session ?? null)) + 1;
      await this.attemptModel.create([{ ...params, attemptNumber, failureReason: params.failureReason ?? null }], { session });
    } catch {
      // never let audit logging break the billing flow
    }
  }

  /**
   * Splits an already-paid subscription invoice into a platform commission
   * and a seller payout, then credits the seller's balance through the same
   * ledger FinanceService already uses for order sales (pending → available
   * after CLEARING_DAYS, via the existing finance clearing cron). Previously
   * NOTHING here — subscription revenue was 100% retained with no seller
   * payout at all (see the audit's business-model finding). Best-effort and
   * run *after* the invoice/subscription write has committed, matching this
   * codebase's established pattern (ActivityLog/notifications) of never
   * letting a secondary ledger effect roll back the primary billing state.
   */
  private async creditSellerPayout(invoice: any) {
    if (invoice.payoutCredited) return;
    try {
      const platformCommissionUSD = this.round(invoice.amountUSD * this.platformCommissionRate);
      const sellerPayoutUSD = this.round(invoice.amountUSD - platformCommissionUSD);

      await this.financeService.recordSubscriptionRevenue(
        invoice.storeId, invoice.sellerId, (invoice)._id.toString(),
        sellerPayoutUSD, platformCommissionUSD,
        `Subscription revenue — invoice ${invoice.invoiceNumber}`,
      );

      await this.invoiceModel.updateOne(
        { _id: invoice._id },
        { $set: { platformCommissionUSD, sellerPayoutUSD, payoutCredited: true } },
      );
    } catch (err: any) {
      this.logger.error(`Failed to credit seller payout for invoice ${invoice.invoiceNumber}: ${err?.message}`);
    }
  }

  /** Fulfills the `credits` plan benefit — grants creditsPerCycle units to the buyer's wallet on every successful charge. */
  private async grantCreditsIfApplicable(sub: any) {
    try {
      const plan = await this.planModel.findById(sub.planId).select('benefits').lean();
      const benefit = ((plan as any)?.benefits ?? []).find((b: any) => b.type === 'credits' && b.enabled !== false && b.creditsPerCycle > 0);
      if (!benefit) return;

      const wallet = await this.creditWalletModel.findOneAndUpdate(
        { customerId: sub.customerId, storeId: sub.storeId, creditType: benefit.creditType ?? 'download' },
        {
          $setOnInsert: { subscriptionId: (sub)._id?.toString?.() ?? sub._id },
          $inc: { balance: benefit.creditsPerCycle, totalGranted: benefit.creditsPerCycle },
        },
        { upsert: true, new: true },
      );
      wallet.ledger.push({
        type: 'grant', amount: benefit.creditsPerCycle, balanceAfter: wallet.balance,
        reason: 'Subscription renewal credit grant', referenceId: sub._id?.toString?.() ?? null, createdAt: new Date(),
      });
      await wallet.save();
    } catch (err: any) {
      this.logger.warn(`Credit grant failed for subscription ${sub._id}: ${err?.message}`);
    }
  }

  /** Denormalizes the buyer's billing country onto the subscription for revenue-by-country analytics. */
  private async resolveBillingCountry(customerId: string): Promise<string | null> {
    const address = await this.db.repositories.addressModel
      .findOne({ userId: customerId, isDefault: true, isDelete: false })
      .select('country').lean();
    return (address as any)?.country ?? null;
  }

  /**
   * Shared dunning-failure state transition — previously duplicated (and
   * subtly diverging) between `processRenewals()` and `subscribe()`'s
   * initial-charge failure path. The initial-subscribe path used to leave a
   * declined buyer in `past_due` with `nextBillingDate` a full billing period
   * away and never sent a payment-failed email, so the very first dunning
   * retry silently didn't happen for up to a month. Both paths now go
   * through this one method: same attempt counter, same short retry window,
   * same auto-cancel threshold, same customer email.
   */
  private async applyDunningFailure(sub: any, chargeAmount: number, planNameOverride?: string) {
    const now = new Date();
    sub.failedPaymentAttempts = (sub.failedPaymentAttempts ?? 0) + 1;

    const { customerName, customerEmail, storeName } = await this.getCustomerAndStoreNames(sub.customerId, sub.storeId);
    const planName = planNameOverride
      ?? (await this.planModel.findById(sub.planId).select('name').lean() as any)?.name
      ?? 'your plan';

    if (sub.failedPaymentAttempts >= MAX_RENEWAL_ATTEMPTS) {
      sub.status = 'canceled';
      sub.canceledAt = now;
      if (sub.providerSubscriptionId) await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
      this.activityLogService.log({
        storeId: sub.storeId, category: 'subscriptions', action: 'subscription_auto_canceled',
        description: `Subscription ${sub._id} auto-canceled after ${MAX_RENEWAL_ATTEMPTS} failed payment attempts`,
        actorRole: 'system', targetId: sub._id?.toString?.() ?? String(sub._id), targetType: 'subscription',
      });
      if (customerEmail) {
        await this.queueEmail('sendSubscriptionCanceledDueToFailedPayments', customerEmail, {
          customerName, storeName, planName, maxAttempts: MAX_RENEWAL_ATTEMPTS,
        });
      }
      this.notificationsService.notify({
        recipientId: sub.customerId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.SUBSCRIPTION_CANCELLED,
        title: 'Membership canceled',
        body: `Your ${storeName} membership was canceled after ${MAX_RENEWAL_ATTEMPTS} failed payment attempts.`,
        data: { subscriptionId: String(sub._id) },
      }).catch(() => {});
      return { canceled: true };
    }

    sub.status = 'past_due';
    const retryAt = new Date(now);
    retryAt.setDate(retryAt.getDate() + RETRY_INTERVAL_DAYS);
    sub.nextBillingDate = retryAt;
    if (customerEmail) {
      await this.queueEmail('sendPaymentFailed', customerEmail, {
        customerName, storeName, planName, amountUSD: chargeAmount,
        attemptNumber: sub.failedPaymentAttempts, maxAttempts: MAX_RENEWAL_ATTEMPTS, nextRetryDate: retryAt,
      });
    }
    this.notificationsService.notify({
      recipientId: sub.customerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.SUBSCRIPTION_PAYMENT_FAILED,
      title: 'Membership payment failed',
      body: `We couldn't process your ${storeName} membership payment — we'll retry on ${retryAt.toDateString()}.`,
      data: { subscriptionId: String(sub._id) },
    }).catch(() => {});
    return { canceled: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — PLANS (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  async createPlan(sellerId: string, storeId: string, dto: CreatePlanDto) {
    await this.verifyStoreOwnership(sellerId, storeId);

    // Platform-plan feature gate — buyer-facing VIP/membership plans are a
    // Business+ tier feature (see EntitlementsService / PlatformPlan.limits).
    await this.entitlementsService.assertFeatureAllowed(storeId, 'subscriptionProductsAllowed', 'Buyer subscription/membership plans');

    const displayCurrency = dto.displayCurrency ?? 'USD';
    let exchangeRateSnapshot: number | null = null;
    if (displayCurrency === 'PKR') {
      exchangeRateSnapshot = this.currency.getCurrentPkrRate();
    }

    const plan = await this.planModel.create({
      sellerId,
      storeId,
      name: dto.name,
      description: dto.description ?? null,
      monthlyPriceUSD: this.round(dto.monthlyPriceUSD),
      yearlyPriceUSD: dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null,
      displayCurrency,
      exchangeRateSnapshot,
      features: dto.features ?? [],
      benefits: dto.benefits ?? [],
      status: 'active',
    });

    this.activityLogService.log({
      storeId, category: 'subscriptions', action: 'plan_created',
      description: `Plan "${plan.name}" created — $${plan.monthlyPriceUSD}/mo`,
      actorId: sellerId, actorRole: 'seller',
      targetId: (plan as any)._id.toString(), targetType: 'subscription_plan',
    });

    return { success: true, data: plan };
  }

  private async enrichPlan(plan: any, includeHealth = true) {
    const planId = plan._id.toString();
    const [subscriberCount, mrrAgg, healthEstimate] = await Promise.all([
      this.subModel.countDocuments({ planId, status: 'active' }),
      this.subModel.aggregate([
        { $match: { planId, status: 'active' } },
        { $group: { _id: '$billingInterval', total: { $sum: '$amountUSD' } } },
      ]),
      includeHealth
        ? this.benefitsService.estimatePlanProfitability(plan.storeId, plan.benefits ?? [], plan.monthlyPriceUSD)
        : Promise.resolve(null),
    ]);

    let monthlyRecurringRevenueUSD = 0;
    for (const row of mrrAgg) monthlyRecurringRevenueUSD += this.toMrrContribution(row.total, row._id);

    return {
      ...plan,
      subscriberCount,
      monthlyRecurringRevenueUSD: this.round(monthlyRecurringRevenueUSD),
      displayMonthlyPrice: this.currency.formatForDisplay(
        plan.monthlyPriceUSD, plan.displayCurrency as 'USD' | 'PKR', plan.exchangeRateSnapshot,
      ),
      healthEstimate,
    };
  }

  async listPlans(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const plans = await this.planModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(plans.map((p) => this.enrichPlan(p)));

    return { success: true, data: enriched };
  }

  async getPlanById(sellerId: string, storeId: string, planId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const plan = await this.verifyPlanInStore(storeId, planId);
    const enriched = await this.enrichPlan(plan.toObject());
    return { success: true, data: enriched };
  }

  async updatePlan(sellerId: string, storeId: string, planId: string, dto: UpdatePlanDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const plan = await this.verifyPlanInStore(storeId, planId);

    if (dto.name !== undefined)           plan.name = dto.name;
    if (dto.description !== undefined)    plan.description = dto.description ?? null;
    if (dto.monthlyPriceUSD !== undefined) plan.monthlyPriceUSD = this.round(dto.monthlyPriceUSD);
    if (dto.yearlyPriceUSD !== undefined)
      plan.yearlyPriceUSD = dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null;
    if (dto.features !== undefined)       plan.features = dto.features;
    if (dto.benefits !== undefined)       plan.benefits = dto.benefits;
    if (dto.status !== undefined) {
      if (plan.status === 'suspended') {
        throw new BadRequestException('This plan was suspended by an admin and cannot be reactivated by the seller');
      }
      plan.status = dto.status;
    }

    if (dto.displayCurrency !== undefined) {
      plan.displayCurrency = dto.displayCurrency;
      plan.exchangeRateSnapshot = dto.displayCurrency === 'PKR' ? this.currency.getCurrentPkrRate() : null;
    }

    await plan.save();
    return { success: true, data: plan };
  }

  async archivePlan(sellerId: string, storeId: string, planId: string, force: boolean) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const plan = await this.verifyPlanInStore(storeId, planId);

    const activeCount = await this.subModel.countDocuments({ planId, status: 'active' });
    if (activeCount > 0 && !force) {
      throw new BadRequestException(
        `This plan has ${activeCount} active subscriber(s). Pass ?force=true to archive anyway (existing subscriptions will continue until canceled).`,
      );
    }

    plan.status = 'archived';
    await plan.save();

    this.activityLogService.log({
      storeId, category: 'subscriptions', action: 'plan_archived',
      description: `Plan "${plan.name}" archived`,
      actorId: sellerId, actorRole: 'seller',
      targetId: planId, targetType: 'subscription_plan',
    });

    return { success: true, message: `Plan archived. ${activeCount} active subscription(s) unaffected.` };
  }

  /** Live profitability preview for the plan builder — before the seller saves anything. */
  async estimatePlanHealth(sellerId: string, storeId: string, benefits: PlanBenefitDto[], monthlyPriceUSD: number) {
    await this.verifyStoreOwnership(sellerId, storeId);
    if (!monthlyPriceUSD || monthlyPriceUSD <= 0) {
      throw new BadRequestException('monthlyPriceUSD is required to estimate plan health');
    }
    const estimate = await this.benefitsService.estimatePlanProfitability(storeId, benefits ?? [], monthlyPriceUSD);
    return { success: true, data: estimate };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — SUBSCRIBERS (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  private async enrichSubForSeller(sub: any) {
    const [customer, plan] = await Promise.all([
      this.db.repositories.userModel.findById(sub.customerId).select('name email profileImage').lean(),
      this.planModel.findById(sub.planId).select('name').lean(),
    ]);
    return {
      ...sub,
      customer: customer ?? { name: 'Unknown', email: 'N/A' },
      planName: (plan as any)?.name ?? 'Plan not found',
      pendingCancellation: this.pendingCancellation(sub),
    };
  }

  async listSubscriptions(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.planId) filter.planId = query.planId;

    const [subs, total] = await Promise.all([
      this.subModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments(filter),
    ]);

    const rows = await Promise.all(subs.map((s) => this.enrichSubForSeller(s)));

    return {
      success: true,
      data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, subscriptions: rows },
    };
  }

  async getSubscriptionById(sellerId: string, storeId: string, subId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);

    const [customer, plan, invoices] = await Promise.all([
      this.db.repositories.userModel.findById(sub.customerId).select('name email phone profileImage').lean(),
      this.planModel.findById(sub.planId).select('name monthlyPriceUSD yearlyPriceUSD features').lean(),
      this.invoiceModel.find({ subscriptionId: subId, isDelete: false }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      success: true,
      data: {
        ...sub.toObject(),
        customer: customer ?? { name: 'Unknown', email: 'N/A' },
        plan: plan ?? null,
        invoices,
        pendingCancellation: this.pendingCancellation(sub),
      },
    };
  }

  /**
   * Refunds a paid (or partially refunded) subscription invoice — wires the
   * previously-unused `PaymentGatewayService.refund()` into a real action.
   * Reverses the seller's already-credited payout share via
   * `FinanceService.recordRefund` (platform commission is NOT refunded,
   * matching this codebase's existing order-refund policy).
   */
  private async refundInvoiceInternal(invoiceId: string, amountUSD: number | undefined, reason: string | undefined, actorId: string, actorRole: 'admin' | 'seller') {
    const invoice = await this.invoiceModel.findOne({ _id: invoiceId, isDelete: false });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!['paid', 'partially_refunded'].includes(invoice.status)) {
      throw new BadRequestException(`Cannot refund an invoice with status "${invoice.status}"`);
    }
    if (!invoice.providerChargeId) {
      throw new BadRequestException('This invoice has no associated charge to refund (fully credit-covered — nothing was actually charged)');
    }

    const remaining = this.round(invoice.amountUSD - (invoice.refundedAmountUSD ?? 0));
    const refundAmount = amountUSD != null ? this.round(amountUSD) : remaining;
    if (refundAmount <= 0 || refundAmount > remaining) {
      throw new BadRequestException(`Refund amount must be between $0.01 and $${remaining.toFixed(2)} (already refunded: $${(invoice.refundedAmountUSD ?? 0).toFixed(2)})`);
    }

    const result = await this.gateway.refund(invoice.providerChargeId, refundAmount, reason);
    if (!result.success) {
      throw new BadRequestException(`Refund failed: ${result.failureReason ?? 'declined by payment provider'}`);
    }

    invoice.refundedAmountUSD = this.round((invoice.refundedAmountUSD ?? 0) + refundAmount);
    invoice.status = invoice.refundedAmountUSD >= invoice.amountUSD ? 'refunded' : 'partially_refunded';
    invoice.refundedAt = new Date();
    invoice.providerRefundId = result.providerRefundId ?? invoice.providerRefundId;
    await invoice.save();

    const sub = await this.subModel.findById(invoice.subscriptionId);
    if (sub) {
      sub.totalPaidUSD = Math.max(0, this.round(sub.totalPaidUSD - refundAmount));
      await sub.save();
    }

    if (invoice.payoutCredited) {
      await this.financeService.recordRefund(invoice.storeId, invoice.sellerId, (invoice as any)._id.toString(), refundAmount, actorId, actorRole, {
        referenceType: 'subscription_invoice',
        description: `Refund — subscription invoice ${invoice.invoiceNumber}${reason ? ` (${reason})` : ''}`,
        targetType: 'subscription_invoice',
      });
    }

    this.activityLogService.log({
      storeId: invoice.storeId, category: 'subscriptions', action: 'invoice_refunded',
      description: `Invoice ${invoice.invoiceNumber} — $${refundAmount.toFixed(2)} refunded${reason ? ` (${reason})` : ''}`,
      actorId, actorRole, targetId: (invoice as any)._id.toString(), targetType: 'subscription_invoice',
    });

    return { success: true, message: `$${refundAmount.toFixed(2)} refunded`, data: invoice };
  }

  /** Seller-initiated refund for one of their own store's subscription invoices. */
  async sellerRefundInvoice(sellerId: string, storeId: string, subId: string, invoiceId: string, amountUSD?: number, reason?: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    await this.verifySubInStore(storeId, subId);
    const invoice = await this.invoiceModel.findOne({ _id: invoiceId, subscriptionId: subId, storeId, isDelete: false });
    if (!invoice) throw new NotFoundException('Invoice not found for this subscription');
    return this.refundInvoiceInternal(invoiceId, amountUSD, reason, sellerId, 'seller');
  }

  /** Admin-initiated refund — can act on any store's invoice. */
  async adminRefundInvoice(adminId: string, invoiceId: string, amountUSD?: number, reason?: string) {
    return this.refundInvoiceInternal(invoiceId, amountUSD, reason, adminId, 'admin');
  }

  // ── Shared status-transition logic (used by both seller override and buyer self-serve) ──

  private applyPause(sub: any) {
    if (sub.status !== 'active') {
      throw new BadRequestException(`Cannot pause a subscription with status "${sub.status}"`);
    }
    sub.status = 'paused';
    sub.pausedAt = new Date();
  }

  private applyResume(sub: any) {
    if (sub.status !== 'paused') {
      throw new BadRequestException(`Cannot resume a subscription with status "${sub.status}"`);
    }
    const now = new Date();
    const newPeriodEnd = this.addPeriod(now, sub.billingInterval as 'monthly' | 'yearly');
    sub.status = 'active';
    sub.pausedAt = null;
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = newPeriodEnd;
    sub.nextBillingDate = newPeriodEnd;
    sub.failedPaymentAttempts = 0;
  }

  private applyCancel(sub: any, atPeriodEnd: boolean, reason?: string): string {
    if (sub.status === 'canceled') throw new BadRequestException('Subscription is already canceled');

    const now = new Date();
    if (reason) sub.cancellationReason = reason;
    if (atPeriodEnd) {
      sub.canceledAt = sub.currentPeriodEnd;
      // Status stays 'active' — finalizeEndOfPeriodCancellations() flips it
      // to 'canceled' once currentPeriodEnd passes.
    } else {
      sub.status = 'canceled';
      sub.canceledAt = now;
    }

    return atPeriodEnd
      ? `Subscription will cancel at end of current period (${sub.currentPeriodEnd.toISOString().split('T')[0]})`
      : 'Subscription canceled immediately';
  }

  async pauseSubscription(sellerId: string, storeId: string, subId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);
    this.applyPause(sub);
    await sub.save();
    return { success: true, message: 'Subscription paused successfully', data: sub };
  }

  async resumeSubscription(sellerId: string, storeId: string, subId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);
    this.applyResume(sub);
    await sub.save();
    return { success: true, message: 'Subscription resumed successfully', data: sub };
  }

  async cancelSubscription(sellerId: string, storeId: string, subId: string, atPeriodEnd: boolean, reason?: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);

    if (sub.providerSubscriptionId) await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
    const message = this.applyCancel(sub, atPeriodEnd, reason);
    await sub.save();

    this.activityLogService.log({
      storeId, category: 'subscriptions', action: 'subscription_canceled_by_seller',
      description: `Subscription ${subId} canceled by seller${atPeriodEnd ? ' (at period end)' : ''}`,
      actorId: sellerId, actorRole: 'seller',
      targetId: subId, targetType: 'subscription',
    });

    return { success: true, message, data: sub };
  }

  async exportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(sellerId, storeId);

    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.planId) filter.planId = query.planId;

    const subs = await this.subModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const customerIds = [...new Set(subs.map((s: any) => s.customerId))];
    const planIds     = [...new Set(subs.map((s: any) => s.planId))];

    const [customers, plans] = await Promise.all([
      this.db.repositories.userModel.find({ _id: { $in: customerIds } }).select('name email').lean(),
      this.planModel.find({ _id: { $in: planIds } }).select('name').lean(),
    ]);

    const customerMap = Object.fromEntries(customers.map((c: any) => [c._id.toString(), c]));
    const planMap     = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p]));

    const header = 'Subscription ID,Customer Name,Customer Email,Plan,Interval,Amount USD,Status,Started At,Next Billing Date,Total Paid USD\n';

    const rows = subs.map((sub: any) => {
      const c = customerMap[sub.customerId] ?? {};
      const p = planMap[sub.planId] ?? {};
      const started = new Date(sub.startedAt).toISOString().split('T')[0];
      const nextBill = new Date(sub.nextBillingDate).toISOString().split('T')[0];
      return [
        sub._id.toString(), `"${c.name ?? ''}"`, `"${c.email ?? ''}"`, `"${(p).name ?? ''}"`,
        sub.billingInterval, sub.amountUSD.toFixed(2), sub.status, started, nextBill, sub.totalPaidUSD.toFixed(2),
      ].join(',');
    });

    return header + rows.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — DASHBOARD (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  private async computeDashboard(filter: { storeId?: string; sellerId?: string }) {
    const match: any = { isDelete: false, ...filter };
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      activeSubs, newThisMonth, canceledThisMonth, totalRevenueAgg,
      planBreakdownRaw, recentInvoices, activeLastMonth,
    ] = await Promise.all([
      this.subModel.find({ ...match, status: 'active' }).lean(),
      this.subModel.countDocuments({ ...match, startedAt: { $gte: thisMonthStart } }),
      this.subModel.countDocuments({ ...match, status: 'canceled', canceledAt: { $gte: thisMonthStart } }),
      this.invoiceModel.aggregate([
        { $match: { ...match, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]),
      this.subModel.aggregate([
        { $match: { ...match, status: 'active' } },
        {
          $group: {
            _id: '$planId',
            subscriberCount: { $sum: 1 },
            monthlyRevenue: { $sum: { $cond: [{ $eq: ['$billingInterval', 'monthly'] }, '$amountUSD', { $divide: ['$amountUSD', 12] }] } },
          },
        },
      ]),
      this.invoiceModel.find({ ...match, status: 'paid' }).sort({ paidAt: -1 }).limit(10).lean(),
      this.subModel.countDocuments({ ...match, status: { $in: ['active', 'canceled', 'paused'] }, startedAt: { $lt: thisMonthStart } }),
    ]);

    const mrr = this.round(activeSubs.reduce((acc: number, sub: any) => acc + this.toMrrContribution(sub.amountUSD, sub.billingInterval), 0));
    const arr = this.round(mrr * 12);
    const churnRate = activeLastMonth > 0 ? this.round((canceledThisMonth / activeLastMonth) * 100) : 0;
    const totalRevenue = this.round(totalRevenueAgg[0]?.total ?? 0);

    const planIds = planBreakdownRaw.map((r: any) => r._id);
    const plans = await this.planModel.find({ _id: { $in: planIds } }).select('name').lean();
    const planNameMap = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p.name]));
    const planBreakdown = planBreakdownRaw.map((r: any) => ({
      planId: r._id, planName: planNameMap[r._id] ?? 'Unknown',
      subscriberCount: r.subscriberCount, mrrContributionUSD: this.round(r.monthlyRevenue),
    }));

    const [thisMonthRevAgg, lastMonthRevAgg] = await Promise.all([
      this.invoiceModel.aggregate([{ $match: { ...match, status: 'paid', paidAt: { $gte: thisMonthStart } } }, { $group: { _id: null, total: { $sum: '$amountUSD' } } }]),
      this.invoiceModel.aggregate([{ $match: { ...match, status: 'paid', paidAt: { $gte: lastMonthStart, $lte: lastMonthEnd } } }, { $group: { _id: null, total: { $sum: '$amountUSD' } } }]),
    ]);
    const revenueThisMonth = this.round(thisMonthRevAgg[0]?.total ?? 0);
    const revenueLastMonth = this.round(lastMonthRevAgg[0]?.total ?? 0);
    const revenueGrowthPercent = revenueLastMonth > 0 ? this.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100) : 0;

    // Cancellation reasons — works for both a single store and platform-wide (admin).
    const cancellationReasonsRaw = await this.subModel.aggregate([
      { $match: { ...match, status: 'canceled', cancellationReason: { $ne: null } } },
      { $group: { _id: '$cancellationReason', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const cancellationReasons = cancellationReasonsRaw.map((r: any) => ({ reason: r._id, count: r.count }));

    // Subscriber-vs-regular revenue & benefit usage — only meaningful (and
    // affordable to compute) at the single-store level, not platform-wide.
    let subscriberEconomics: {
      subscriberRevenue: number; regularRevenue: number;
      subscriberOrderCount: number; regularOrderCount: number;
      avgOrdersPerSubscriber: number; avgOrdersPerRegularCustomer: number;
      totalCustomerSavingsUSD: number;
    } | null = null;

    if (filter.storeId) {
      const storeId = filter.storeId;
      const [subscriberIds, orders] = await Promise.all([
        this.subModel.distinct('customerId', { storeId }),
        this.db.repositories.orderModel.find({
          'sellerOrders.storeId': storeId, isDelete: false, paymentStatus: 'paid',
        }).select('userId sellerOrders subscriberDiscountTotal').lean(),
      ]);
      const subscriberIdSet = new Set(subscriberIds);

      let subscriberRevenue = 0, regularRevenue = 0, subscriberOrderCount = 0, regularOrderCount = 0, totalCustomerSavingsUSD = 0;
      const subscriberCustomers = new Set<string>();
      const regularCustomers = new Set<string>();

      for (const order of orders as any[]) {
        const orderValue = ((order.sellerOrders as any[]) ?? [])
          .filter(so => so.storeId === storeId)
          .reduce((s, so) => s + so.subtotal, 0);
        totalCustomerSavingsUSD += order.subscriberDiscountTotal ?? 0;

        if (subscriberIdSet.has(order.userId)) {
          subscriberRevenue += orderValue;
          subscriberOrderCount += 1;
          subscriberCustomers.add(order.userId);
        } else {
          regularRevenue += orderValue;
          regularOrderCount += 1;
          regularCustomers.add(order.userId);
        }
      }

      subscriberEconomics = {
        subscriberRevenue: this.round(subscriberRevenue),
        regularRevenue: this.round(regularRevenue),
        subscriberOrderCount,
        regularOrderCount,
        avgOrdersPerSubscriber: subscriberCustomers.size > 0 ? this.round(subscriberOrderCount / subscriberCustomers.size) : 0,
        avgOrdersPerRegularCustomer: regularCustomers.size > 0 ? this.round(regularOrderCount / regularCustomers.size) : 0,
        totalCustomerSavingsUSD: this.round(totalCustomerSavingsUSD),
      };
    }

    return {
      mrr, arr, activeSubscribersCount: activeSubs.length, totalRevenue,
      newSubscribersThisMonth: newThisMonth, canceledThisMonth, churnRate,
      revenueThisMonth, revenueLastMonth, revenueGrowthPercent,
      planBreakdown, recentInvoices, cancellationReasons, subscriberEconomics,
    };
  }

  async getDashboard(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const data = await this.computeDashboard({ storeId });
    return { success: true, data };
  }

  /**
   * Conversion rate, 30-day retention, LTV, and upgrade/downgrade counts —
   * previously none of these existed for sellers. Conversion rate is
   * computed against the store's real customer base (anyone who has ever
   * placed an order there), not an invented "visitor" number this module
   * has no data source for — the same grounding `computeDashboard` already
   * uses for `subscriberEconomics`.
   */
  async getAdvancedSellerAnalytics(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      subscriberIds, allCustomerIds, startedOver30dAgo, stillActiveOfThose,
      realizedLtvAgg, activeSoFarAgg, planChangeAgg,
    ] = await Promise.all([
      this.subModel.distinct('customerId', { storeId }),
      this.db.repositories.orderModel.distinct('userId', { 'sellerOrders.storeId': storeId, isDelete: false }),
      this.subModel.countDocuments({ storeId, startedAt: { $lte: thirtyDaysAgo }, isDelete: false }),
      this.subModel.countDocuments({ storeId, startedAt: { $lte: thirtyDaysAgo }, status: 'active', isDelete: false }),
      this.subModel.aggregate([
        { $match: { storeId, status: 'canceled', isDelete: false } },
        { $group: { _id: null, avg: { $avg: '$totalPaidUSD' }, count: { $sum: 1 } } },
      ]),
      this.subModel.aggregate([
        { $match: { storeId, status: 'active', isDelete: false } },
        { $group: { _id: null, avg: { $avg: '$totalPaidUSD' }, count: { $sum: 1 } } },
      ]),
      this.subModel.aggregate([
        { $match: { storeId, isDelete: false } },
        { $unwind: '$planHistory' },
        { $group: { _id: { $cond: [{ $gt: ['$planHistory.proratedAmountUSD', 0] }, 'upgrade', 'downgrade'] }, count: { $sum: 1 } } },
      ]),
    ]);

    const conversionRatePercent = allCustomerIds.length > 0 ? this.round((subscriberIds.length / allCustomerIds.length) * 100) : 0;
    const retention30dPercent = startedOver30dAgo > 0 ? this.round((stillActiveOfThose / startedOver30dAgo) * 100) : 0;
    const upgradeCount = planChangeAgg.find((r: any) => r._id === 'upgrade')?.count ?? 0;
    const downgradeCount = planChangeAgg.find((r: any) => r._id === 'downgrade')?.count ?? 0;

    // Lightweight, transparent rules-based recommendations — deliberately NOT
    // marketed as "AI insights": there's no model behind this, just clear
    // thresholds a seller can inspect and disagree with.
    const recommendations: string[] = [];
    if (startedOver30dAgo >= 5 && retention30dPercent < 50) {
      recommendations.push('30-day retention is below 50% — consider strengthening your plan\'s benefits (e.g. a bigger discount or free shipping) or reviewing whether the price matches the value delivered.');
    }
    if (allCustomerIds.length >= 20 && conversionRatePercent < 2) {
      recommendations.push('Fewer than 2% of your customers have subscribed — consider promoting your plan more prominently on product pages or at checkout.');
    }
    if (downgradeCount > upgradeCount && (upgradeCount + downgradeCount) >= 5) {
      recommendations.push('Downgrades are outpacing upgrades — this often signals your higher tier is priced above its perceived value.');
    }
    if (recommendations.length === 0) recommendations.push('No red flags detected in your current subscription performance.');

    return {
      success: true,
      data: {
        conversionRatePercent, retention30dPercent,
        realizedLtvUSD: this.round(realizedLtvAgg[0]?.avg ?? 0), realizedLtvSampleSize: realizedLtvAgg[0]?.count ?? 0,
        activeAvgRevenueToDateUSD: this.round(activeSoFarAgg[0]?.avg ?? 0), activeSampleSize: activeSoFarAgg[0]?.count ?? 0,
        upgradeCount, downgradeCount,
        recommendations,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — DISCOVERY & SELF-SERVICE
  // ═══════════════════════════════════════════════════════════════════════════

  async browsePlans(storeId: string) {
    const store = await this.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');

    const plans = await this.planModel.find({ storeId, status: 'active', isDelete: false }).sort({ monthlyPriceUSD: 1 }).lean();

    const data = plans.map((plan: any) => ({
      _id: plan._id, name: plan.name, description: plan.description,
      monthlyPriceUSD: plan.monthlyPriceUSD, yearlyPriceUSD: plan.yearlyPriceUSD,
      features: plan.features,
      // Structured benefits — the storefront renders these into concrete
      // "Save 15% storewide" / "Free shipping" bullets, not the seller's
      // free-text `features`.
      benefits: plan.benefits ?? [],
      displayCurrency: plan.displayCurrency,
      displayMonthlyPrice: this.currency.formatForDisplay(plan.monthlyPriceUSD, plan.displayCurrency, plan.exchangeRateSnapshot),
      displayYearlyPrice: plan.yearlyPriceUSD != null
        ? this.currency.formatForDisplay(plan.yearlyPriceUSD, plan.displayCurrency, plan.exchangeRateSnapshot)
        : null,
    }));

    return { success: true, data };
  }

  /** Buyer subscribes to a store's plan. This is the (formerly-dead) internal createSubscription, now reachable. */
  async subscribe(customerId: string, dto: SubscribeDto, idempotencyKey?: string) {
    const plan = await this.planModel.findOne({ _id: dto.planId, isDelete: false, status: 'active' });
    if (!plan) throw new NotFoundException('Subscription plan not found or inactive');

    const store = await this.storeModel.findById(plan.storeId);
    if (!store || store.isDelete || store.status !== 'active') {
      throw new BadRequestException('This store is not currently accepting subscriptions');
    }

    const amountUSD = dto.billingInterval === 'yearly'
      ? (plan.yearlyPriceUSD ?? this.round(plan.monthlyPriceUSD * 12))
      : plan.monthlyPriceUSD;

    const now = new Date();
    const periodEnd = this.addPeriod(now, dto.billingInterval);
    const billingCountry = await this.resolveBillingCountry(customerId);

    // Atomic insert-or-fail — replaces the previous check-then-create race
    // (two concurrent POST /subscribe calls for the same customer+plan could
    // both pass the "does one already exist" check before either had
    // written, creating two active subscriptions and double-charging the
    // buyer). The partial unique index on {customerId, planId} for
    // active/paused subs now makes the second insert fail with E11000 instead.
    let sub: any;
    try {
      sub = await this.subModel.create({
        planId: dto.planId,
        customerId,
        storeId: plan.storeId,
        sellerId: plan.sellerId,
        billingInterval: dto.billingInterval,
        amountUSD: this.round(amountUSD),
        status: 'active',
        startedAt: now,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        paymentProvider: this.gateway.providerName,
        billingCountry,
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('You already have an active subscription to this plan');
      throw err;
    }

    const subId = (sub)._id.toString();

    // ── Stripe-backed subscription: Stripe owns the billing cycle from here ──
    // We only ever *create* it; every renewal outcome (paid/failed) arrives
    // later via webhook (see StripeWebhookProcessor / handleStripeInvoice*).
    if (this.gateway.isProviderDrivenBilling) {
      const user = await this.db.repositories.userModel.findById(customerId);
      if (!user) throw new NotFoundException('Buyer account not found');

      if (!user.stripeCustomerId) {
        const { providerCustomerId } = await this.gateway.getOrCreateCustomer(customerId, user.email, user.name ?? '');
        user.stripeCustomerId = providerCustomerId;
        await user.save();
      }

      if (!plan[dto.billingInterval === 'yearly' ? 'stripeYearlyPriceId' : 'stripeMonthlyPriceId']) {
        const { providerProductId, providerPriceId } = await this.gateway.getOrCreatePrice({
          planId: plan._id.toString(), planName: plan.name, storeId: plan.storeId,
          amountUSD, interval: dto.billingInterval,
          existingProductId: plan.stripeProductId,
        });
        plan.stripeProductId = providerProductId;
        if (dto.billingInterval === 'yearly') plan.stripeYearlyPriceId = providerPriceId;
        else plan.stripeMonthlyPriceId = providerPriceId;
        await plan.save();
      }

      const providerPriceId = dto.billingInterval === 'yearly' ? plan.stripeYearlyPriceId : plan.stripeMonthlyPriceId;

      const { providerSubscriptionId, clientSecret, status } = await this.gateway.createProviderSubscription(
        subId, plan.name, amountUSD, dto.billingInterval,
        { providerCustomerId: user.stripeCustomerId, providerPriceId, idempotencyKey, metadata: { storeId: plan.storeId } },
      );

      sub.providerSubscriptionId = providerSubscriptionId;
      sub.stripeCustomerId = user.stripeCustomerId;
      // Stripe's `default_incomplete` flow always starts 'incomplete' until the
      // frontend confirms the returned PaymentIntent — our local status
      // reflects that as 'past_due' (no benefits granted) until the
      // `invoice.payment_succeeded` webhook flips it to 'active'.
      sub.status = status === 'active' ? 'active' : 'past_due';
      await sub.save();

      this.activityLogService.log({
        storeId: plan.storeId, category: 'subscriptions', action: 'subscriber_joined',
        description: `New Stripe subscriber on "${plan.name}" (${dto.billingInterval}) — awaiting payment confirmation`,
        actorId: customerId, actorRole: 'user',
        targetId: subId, targetType: 'subscription',
      });

      return {
        success: true,
        data: {
          subscription: sub,
          requiresAction: !!clientSecret,
          clientSecret: clientSecret ?? null,
        },
      };
    }

    // ── Manual provider (dev/test, or no Stripe keys configured yet) ──
    const charge = await this.gateway.chargeSubscription(subId, amountUSD, { idempotencyKey });

    const invoice = await this.invoiceModel.create({
      subscriptionId: subId,
      storeId: plan.storeId,
      sellerId: plan.sellerId,
      customerId,
      invoiceNumber: await this.generateInvoiceNumber(),
      type: 'initial',
      amountUSD: this.round(amountUSD),
      status: charge.success ? 'paid' : 'failed',
      paidAt: charge.success ? now : null,
      providerChargeId: charge.providerChargeId,
      paymentMethodType: charge.paymentMethodType ?? 'manual',
      countryCode: billingCountry,
    });

    await this.recordPaymentAttempt({
      subscriptionId: subId, storeId: plan.storeId, sellerId: plan.sellerId, customerId,
      attemptType: 'initial', outcome: charge.success ? 'success' : 'failed',
      amountUSD: this.round(amountUSD),
      failureReason: charge.success ? null : (charge.failureReason ?? 'Payment declined'),
      failureCode: charge.failureCode ?? null,
      invoiceId: (invoice as any)._id.toString(), providerChargeId: charge.providerChargeId,
    });

    if (charge.success) {
      sub.totalPaidUSD = this.round(amountUSD);
      sub.lastPaymentMethodType = charge.paymentMethodType ?? 'manual';
      await sub.save();
      await this.creditSellerPayout(invoice);
      await this.grantCreditsIfApplicable(sub);
    } else {
      // Previously: status='past_due' with nextBillingDate a full period away,
      // no email, no dunning counter — a declined first payment silently sat
      // unretried for up to a month. Now goes through the same dunning
      // machinery as a failed renewal.
      await this.applyDunningFailure(sub, amountUSD, plan.name);
      await sub.save();
    }

    this.activityLogService.log({
      storeId: plan.storeId, category: 'subscriptions', action: 'subscriber_joined',
      description: `New subscriber on "${plan.name}" (${dto.billingInterval})`,
      actorId: customerId, actorRole: 'user',
      targetId: subId, targetType: 'subscription',
    });

    return { success: true, data: { subscription: sub, invoice } };
  }

  async listMySubscriptions(customerId: string, query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { customerId, isDelete: false };
    if (query.status) filter.status = query.status;

    const [subs, total] = await Promise.all([
      this.subModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments(filter),
    ]);

    const rows = await Promise.all(subs.map(async (sub: any) => {
      const [store, plan] = await Promise.all([
        this.storeModel.findById(sub.storeId).select('name logo slug').lean(),
        this.planModel.findById(sub.planId).select('name features').lean(),
      ]);
      return {
        ...sub,
        store: store ?? null,
        plan: plan ?? null,
        pendingCancellation: this.pendingCancellation(sub),
      };
    }));

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, subscriptions: rows } };
  }

  async getMySubscriptionById(customerId: string, subId: string) {
    const sub = await this.verifyMySub(customerId, subId);

    const [store, plan, invoices] = await Promise.all([
      this.storeModel.findById(sub.storeId).select('name logo slug').lean(),
      this.planModel.findById(sub.planId).select('name monthlyPriceUSD yearlyPriceUSD features').lean(),
      this.invoiceModel.find({ subscriptionId: subId, isDelete: false }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      success: true,
      data: { ...sub.toObject(), store: store ?? null, plan: plan ?? null, invoices, pendingCancellation: this.pendingCancellation(sub) },
    };
  }

  async selfPauseSubscription(customerId: string, subId: string) {
    const sub = await this.verifyMySub(customerId, subId);
    this.applyPause(sub);
    await sub.save();
    return { success: true, message: 'Subscription paused successfully', data: sub };
  }

  async selfResumeSubscription(customerId: string, subId: string) {
    const sub = await this.verifyMySub(customerId, subId);
    this.applyResume(sub);
    await sub.save();
    return { success: true, message: 'Subscription resumed successfully', data: sub };
  }

  async selfCancelSubscription(customerId: string, subId: string, atPeriodEnd: boolean, reason?: string) {
    const sub = await this.verifyMySub(customerId, subId);

    if (sub.providerSubscriptionId) await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
    const message = this.applyCancel(sub, atPeriodEnd, reason);
    await sub.save();

    this.activityLogService.log({
      storeId: sub.storeId, category: 'subscriptions', action: 'subscription_canceled_by_customer',
      description: `Subscription ${subId} canceled by the customer${atPeriodEnd ? ' (at period end)' : ''}`,
      actorId: customerId, actorRole: 'user',
      targetId: subId, targetType: 'subscription',
    });

    return { success: true, message, data: sub };
  }

  /**
   * Buyer switches plan and/or billing interval mid-cycle. Proration mirrors
   * standard SaaS behavior (e.g. Stripe):
   *  - Unused time on the current plan is converted to a USD credit
   *    (currentAmount × remaining-time-ratio), combined with any existing
   *    creditBalanceUSD.
   *  - The new plan's full price is charged, minus that credit.
   *  - If the credit exceeds the new price (e.g. yearly → monthly downgrade
   *    mid-cycle), the leftover becomes account credit for the next charge —
   *    never an instant cash refund, since there's no real gateway to refund
   *    through yet.
   *  - The new period always restarts from now (today = new currentPeriodStart).
   */
  async changePlan(customerId: string, subId: string, dto: ChangePlanDto, idempotencyKey?: string) {
    const sub = await this.verifyMySub(customerId, subId);

    if (sub.status !== 'active') {
      throw new BadRequestException(`Cannot change plan while subscription status is "${sub.status}" — resume it first`);
    }

    const [oldPlan, newPlan] = await Promise.all([
      this.planModel.findById(sub.planId),
      this.planModel.findOne({ _id: dto.newPlanId, isDelete: false }),
    ]);
    if (!newPlan) throw new NotFoundException('Target subscription plan not found');
    if (newPlan.storeId !== sub.storeId) throw new BadRequestException('Cannot switch to a plan from a different store');
    if (newPlan.status !== 'active') throw new BadRequestException('This plan is not currently available');
    if (dto.newPlanId === sub.planId && dto.newBillingInterval === sub.billingInterval) {
      throw new BadRequestException('This is already your current plan and billing interval');
    }

    const newAmountUSD = dto.newBillingInterval === 'yearly'
      ? (newPlan.yearlyPriceUSD ?? this.round(newPlan.monthlyPriceUSD * 12))
      : newPlan.monthlyPriceUSD;

    const now = new Date();
    const totalPeriodMs = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, sub.currentPeriodEnd.getTime() - now.getTime());
    const remainingRatio = totalPeriodMs > 0 ? Math.min(1, remainingMs / totalPeriodMs) : 0;

    const unusedCredit = this.round(sub.amountUSD * remainingRatio);
    const totalCreditAvailable = this.round(unusedCredit + (sub.creditBalanceUSD ?? 0));
    const netDue = this.round(newAmountUSD - totalCreditAvailable);

    const historyEntry = {
      fromPlanId: sub.planId, fromPlanName: oldPlan?.name ?? 'Unknown plan',
      fromBillingInterval: sub.billingInterval, fromAmountUSD: sub.amountUSD,
      toPlanId: dto.newPlanId, toPlanName: newPlan.name,
      toBillingInterval: dto.newBillingInterval, toAmountUSD: this.round(newAmountUSD),
      proratedAmountUSD: netDue, changedAt: now,
    };

    let invoice: any = null;
    let description: string;

    if (netDue > 0) {
      // Upgrade (or credit didn't fully cover it) — charge the difference now.
      // Charged via our own proration math on BOTH providers (rather than
      // delegating to Stripe's native proration engine) so the resulting
      // creditBalanceUSD/totalPaidUSD ledger stays identical and comparable
      // across manual and Stripe-backed subscriptions for dashboards/analytics.
      const charge = await this.gateway.chargeSubscription(subId, netDue, { providerCustomerId: sub.stripeCustomerId ?? undefined, idempotencyKey });

      invoice = await this.invoiceModel.create({
        subscriptionId: subId, storeId: sub.storeId, sellerId: sub.sellerId, customerId,
        invoiceNumber: await this.generateInvoiceNumber(), type: 'proration',
        amountUSD: netDue, status: charge.success ? 'paid' : 'failed',
        paidAt: charge.success ? now : null, providerChargeId: charge.providerChargeId,
        paymentMethodType: charge.paymentMethodType ?? null,
      });

      await this.recordPaymentAttempt({
        subscriptionId: subId, storeId: sub.storeId, sellerId: sub.sellerId, customerId,
        attemptType: 'proration', outcome: charge.success ? 'success' : 'failed',
        amountUSD: netDue, failureReason: charge.success ? null : (charge.failureReason ?? 'Payment declined'),
        failureCode: charge.failureCode ?? null,
        invoiceId: (invoice)._id.toString(), providerChargeId: charge.providerChargeId,
      });

      if (!charge.success) {
        throw new BadRequestException(`Proration payment of $${netDue.toFixed(2)} failed — plan was not changed`);
      }

      sub.totalPaidUSD = this.round(sub.totalPaidUSD + netDue);
      sub.creditBalanceUSD = 0;
      description = `Changed from "${historyEntry.fromPlanName}" (${sub.billingInterval}) to "${newPlan.name}" (${dto.newBillingInterval}) — $${netDue.toFixed(2)} charged`;
      await this.creditSellerPayout(invoice);
    } else {
      // Downgrade — credit covers the new plan in full; leftover carries forward.
      sub.creditBalanceUSD = this.round(-netDue);
      description = `Changed from "${historyEntry.fromPlanName}" (${sub.billingInterval}) to "${newPlan.name}" (${dto.newBillingInterval}) — $${sub.creditBalanceUSD.toFixed(2)} credited to account`;
    }

    sub.planId = dto.newPlanId;
    sub.billingInterval = dto.newBillingInterval;
    sub.amountUSD = this.round(newAmountUSD);
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = this.addPeriod(now, dto.newBillingInterval);
    sub.nextBillingDate = sub.currentPeriodEnd;
    sub.failedPaymentAttempts = 0;
    sub.canceledAt = null; // changing plan implies the buyer wants to continue
    sub.planHistory = [...(sub.planHistory ?? []), historyEntry];

    await sub.save();
    await this.grantCreditsIfApplicable(sub);

    // Keep Stripe's own subscription object pointed at the new price for
    // *future* Stripe-driven renewals — proration_behavior:'none' because we
    // already charged/credited the exact delta ourselves above; letting
    // Stripe also apply its own proration would double-charge the buyer.
    if (this.gateway.isProviderDrivenBilling && sub.providerSubscriptionId) {
      const newProviderPriceId = dto.newBillingInterval === 'yearly' ? newPlan.stripeYearlyPriceId : newPlan.stripeMonthlyPriceId;
      if (newProviderPriceId) {
        try {
          await this.gateway.updateProviderSubscriptionPrice(sub.providerSubscriptionId, newProviderPriceId, 'none');
        } catch (err: any) {
          this.logger.warn(`Failed to sync Stripe subscription price after plan change on ${subId}: ${err?.message}`);
        }
      }
    }

    this.activityLogService.log({
      storeId: sub.storeId, category: 'subscriptions', action: 'plan_changed_by_customer',
      description, actorId: customerId, actorRole: 'user',
      targetId: subId, targetType: 'subscription',
      metadata: historyEntry,
    });

    const { customerName, customerEmail, storeName } = await this.getCustomerAndStoreNames(customerId, sub.storeId);
    if (customerEmail) {
      if (netDue > 0) {
        await this.queueEmail('sendProrationCharged', customerEmail, {
          customerName, storeName,
          fromPlanName: historyEntry.fromPlanName, toPlanName: newPlan.name,
          fromInterval: historyEntry.fromBillingInterval, toInterval: dto.newBillingInterval,
          amountUSD: netDue,
        }, customerId);
      } else {
        await this.queueEmail('sendProrationCredited', customerEmail, {
          customerName, storeName,
          fromPlanName: historyEntry.fromPlanName, toPlanName: newPlan.name,
          fromInterval: historyEntry.fromBillingInterval, toInterval: dto.newBillingInterval,
          creditUSD: sub.creditBalanceUSD,
        }, customerId);
      }
    }

    return { success: true, message: description, data: { subscription: sub, invoice } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — PLATFORM OVERSIGHT
  // ═══════════════════════════════════════════════════════════════════════════

  async adminGetOverview() {
    const data = await this.computeDashboard({});
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [planCount, storeCount, failedPaymentsLast30Days, pastDueCount] = await Promise.all([
      this.planModel.countDocuments({ isDelete: false, status: 'active' }),
      this.planModel.distinct('storeId', { isDelete: false, status: 'active' }).then((ids) => ids.length),
      this.attemptModel.countDocuments({ outcome: 'failed', createdAt: { $gte: thirtyDaysAgo } }),
      this.subModel.countDocuments({ status: 'past_due', isDelete: false }),
    ]);

    return {
      success: true,
      data: { ...data, activePlanCount: planCount, storesWithActivePlans: storeCount, failedPaymentsLast30Days, pastDueSubscriptionsCount: pastDueCount },
    };
  }

  /** Revenue cut by store/seller, country, and payment method — none of these breakdowns existed before this audit. */
  async adminGetRevenueBreakdown(query: any) {
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : new Date();
    const match = { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } };

    const [byStoreRaw, byCountryRaw, byPaymentMethodRaw] = await Promise.all([
      this.invoiceModel.aggregate([
        { $match: match },
        { $group: { _id: '$storeId', total: { $sum: '$amountUSD' }, count: { $sum: 1 }, sellerPayout: { $sum: '$sellerPayoutUSD' }, platformCommission: { $sum: '$platformCommissionUSD' } } },
        { $sort: { total: -1 } },
        { $limit: 50 },
      ]),
      this.invoiceModel.aggregate([
        { $match: match },
        { $group: { _id: { $ifNull: ['$countryCode', 'unknown'] }, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      this.invoiceModel.aggregate([
        { $match: match },
        { $group: { _id: { $ifNull: ['$paymentMethodType', 'unknown'] }, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    const storeIds = byStoreRaw.map((r: any) => r._id);
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name slug sellerId').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: {
        byStore: byStoreRaw.map((r: any) => ({
          storeId: r._id, storeName: storeMap[r._id]?.name ?? 'Unknown store', sellerId: storeMap[r._id]?.sellerId ?? null,
          totalUSD: this.round(r.total), invoiceCount: r.count,
          sellerPayoutUSD: this.round(r.sellerPayout), platformCommissionUSD: this.round(r.platformCommission),
        })),
        byCountry: byCountryRaw.map((r: any) => ({ country: r._id, totalUSD: this.round(r.total), invoiceCount: r.count })),
        byPaymentMethod: byPaymentMethodRaw.map((r: any) => ({ paymentMethodType: r._id, totalUSD: this.round(r.total), invoiceCount: r.count })),
        note: 'byCountry is only as complete as buyers\' default-address country data — addresses saved before this field existed show as "unknown".',
      },
    };
  }

  /** Simple monthly-cohort retention — % of subscribers who started in month X that are still active today. */
  async adminGetChurnCohorts(query: any) {
    const monthsBack = Math.min(12, parseInt(query.months) || 6);
    const now = new Date();
    const cohorts: any[] = [];

    for (let i = monthsBack - 1; i >= 0; i--) {
      const cohortStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const cohortEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const [totalStarted, stillActive] = await Promise.all([
        this.subModel.countDocuments({ startedAt: { $gte: cohortStart, $lt: cohortEnd }, isDelete: false }),
        this.subModel.countDocuments({ startedAt: { $gte: cohortStart, $lt: cohortEnd }, status: 'active', isDelete: false }),
      ]);
      cohorts.push({
        cohort: `${cohortStart.getFullYear()}-${String(cohortStart.getMonth() + 1).padStart(2, '0')}`,
        totalStarted, stillActive,
        retentionPercent: totalStarted > 0 ? this.round((stillActive / totalStarted) * 100) : 0,
      });
    }

    return { success: true, data: cohorts };
  }

  /** Platform-wide lifetime value: realized (fully churned) vs. revenue-to-date for still-active subscriptions. */
  async adminGetLtv() {
    const [realized, activeSoFar] = await Promise.all([
      this.subModel.aggregate([
        { $match: { status: 'canceled', isDelete: false } },
        { $group: { _id: null, avgLtv: { $avg: '$totalPaidUSD' }, count: { $sum: 1 } } },
      ]),
      this.subModel.aggregate([
        { $match: { status: 'active', isDelete: false } },
        { $group: { _id: null, avgSoFar: { $avg: '$totalPaidUSD' }, count: { $sum: 1 } } },
      ]),
    ]);

    return {
      success: true,
      data: {
        realizedLtvUSD: this.round(realized[0]?.avgLtv ?? 0),
        canceledSubscriptionsSampled: realized[0]?.count ?? 0,
        activeAvgRevenueToDateUSD: this.round(activeSoFar[0]?.avgSoFar ?? 0),
        activeSubscriptionsSampled: activeSoFar[0]?.count ?? 0,
        note: 'realizedLtvUSD = average totalPaidUSD across fully-canceled subscriptions (a true completed lifetime value). activeAvgRevenueToDateUSD is revenue collected so far from still-active subscriptions — a floor, not a completed-lifetime prediction.',
      },
    };
  }

  /** Dead-letter / audit view of every Stripe webhook event received, including permanently-failed jobs. */
  async adminGetWebhookHistory(query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;

    const [events, total] = await Promise.all([
      this.db.repositories.webhookEventModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.db.repositories.webhookEventModel.countDocuments(filter),
    ]);

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, events } };
  }

  /** Manually re-queues a webhook event stuck in 'failed' — the dead-letter "replay" action. */
  async adminRetryWebhook(id: string) {
    const event = await this.db.repositories.webhookEventModel.findById(id);
    if (!event) throw new NotFoundException('Webhook event not found');

    await this.db.repositories.webhookEventModel.updateOne({ _id: id }, { $set: { status: 'received' } });
    await this.webhookQueue.add('process-stripe-event', { eventId: event.providerEventId, type: event.type });

    return { success: true, message: 'Webhook event re-queued for processing' };
  }

  // ── Dunning / retry history ──────────────────────────────────────────────

  async adminGetPaymentFailures(query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { outcome: 'failed' };
    if (query.storeId) filter.storeId = query.storeId;
    if (query.attemptType) filter.attemptType = query.attemptType;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to)   filter.createdAt.$lte = new Date(query.to);
    }

    const [attempts, total] = await Promise.all([
      this.attemptModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.attemptModel.countDocuments(filter),
    ]);

    const storeIds = [...new Set(attempts.map((a: any) => a.storeId))];
    const customerIds = [...new Set(attempts.map((a: any) => a.customerId))];
    const [stores, customers] = await Promise.all([
      this.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean(),
      this.db.repositories.userModel.find({ _id: { $in: customerIds } }).select('name email').lean(),
    ]);
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));
    const customerMap = Object.fromEntries(customers.map((c: any) => [c._id.toString(), c]));

    const rows = attempts.map((a: any) => ({
      ...a,
      store: storeMap[a.storeId] ?? null,
      customer: customerMap[a.customerId] ?? null,
    }));

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, failures: rows } };
  }

  async adminGetSubscriptionDetail(subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, isDelete: false }).lean();
    if (!sub) throw new NotFoundException('Subscription not found');

    const [store, customer, plan, invoices, attempts] = await Promise.all([
      this.storeModel.findById((sub as any).storeId).select('name slug sellerId').lean(),
      this.db.repositories.userModel.findById((sub as any).customerId).select('name email phone').lean(),
      this.planModel.findById((sub as any).planId).select('name monthlyPriceUSD yearlyPriceUSD').lean(),
      this.invoiceModel.find({ subscriptionId: subId, isDelete: false }).sort({ createdAt: -1 }).lean(),
      this.attemptModel.find({ subscriptionId: subId }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      success: true,
      data: { ...sub, store, customer, plan, invoices, paymentAttempts: attempts, pendingCancellation: this.pendingCancellation(sub) },
    };
  }

  async adminGetSubscriptionPaymentAttempts(subId: string, query: any) {
    const exists = await this.subModel.exists({ _id: subId });
    if (!exists) throw new NotFoundException('Subscription not found');

    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { subscriptionId: subId };
    if (query.outcome) filter.outcome = query.outcome;

    const [attempts, total] = await Promise.all([
      this.attemptModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.attemptModel.countDocuments(filter),
    ]);

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, attempts } };
  }

  async adminGetStoreBreakdown(query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const grouped = await this.subModel.aggregate([
      { $match: { status: 'active', isDelete: false } },
      {
        $group: {
          _id: '$storeId',
          subscriberCount: { $sum: 1 },
          monthlyRevenue: { $sum: { $cond: [{ $eq: ['$billingInterval', 'monthly'] }, '$amountUSD', { $divide: ['$amountUSD', 12] }] } },
        },
      },
      { $sort: { monthlyRevenue: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);

    const total = (await this.subModel.aggregate([
      { $match: { status: 'active', isDelete: false } },
      { $group: { _id: '$storeId' } },
      { $count: 'total' },
    ]))[0]?.total ?? 0;

    const storeIds = grouped.map((r: any) => r._id);
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name slug sellerId').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    const planCounts = await this.planModel.aggregate([
      { $match: { storeId: { $in: storeIds }, isDelete: false } },
      { $group: { _id: '$storeId', count: { $sum: 1 } } },
    ]);
    const planCountMap = Object.fromEntries(planCounts.map((r: any) => [r._id, r.count]));

    const rows = grouped.map((r: any) => ({
      storeId: r._id,
      storeName: storeMap[r._id]?.name ?? 'Unknown store',
      storeSlug: storeMap[r._id]?.slug ?? null,
      sellerId: storeMap[r._id]?.sellerId ?? null,
      subscriberCount: r.subscriberCount,
      mrrUSD: this.round(r.monthlyRevenue),
      planCount: planCountMap[r._id] ?? 0,
    }));

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, stores: rows } };
  }

  async adminGetStoreDetail(storeId: string) {
    const store = await this.storeModel.findById(storeId).select('name slug sellerId').lean();
    if (!store) throw new NotFoundException('Store not found');

    const [plans, dashboard] = await Promise.all([
      this.planModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean().then((ps) => Promise.all(ps.map((p) => this.enrichPlan(p)))),
      this.computeDashboard({ storeId }),
    ]);

    return { success: true, data: { store, plans, ...dashboard } };
  }

  async adminSuspendPlan(planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');

    plan.status = 'suspended';
    await plan.save();

    this.activityLogService.log({
      storeId: plan.storeId, category: 'subscriptions', action: 'plan_suspended_by_admin',
      description: `Plan "${plan.name}" suspended by admin`,
      actorRole: 'admin', targetId: planId, targetType: 'subscription_plan', isSecurityAlert: true,
    });

    return { success: true, message: 'Plan suspended. Existing subscribers are unaffected; no new subscriptions can be created.', data: plan };
  }

  async adminUnsuspendPlan(planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    if (plan.status !== 'suspended') throw new BadRequestException('Plan is not suspended');

    plan.status = 'active';
    await plan.save();

    this.activityLogService.log({
      storeId: plan.storeId, category: 'subscriptions', action: 'plan_unsuspended_by_admin',
      description: `Plan "${plan.name}" reinstated by admin`,
      actorRole: 'admin', targetId: planId, targetType: 'subscription_plan',
    });

    return { success: true, message: 'Plan reinstated.', data: plan };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BILLING AUTOMATION — called by SchedulerService cron jobs.
  // Uses PaymentGatewayService (currently ManualPaymentProvider, always
  // succeeds) so the full renewal/dunning state machine is real and testable
  // today. Swapping in a real provider later requires no changes here.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Charges every MANUAL-provider subscription whose period has ended, and
   * drives dunning on failure. Stripe-backed subscriptions are deliberately
   * excluded — Stripe's own billing engine issues their renewal invoices and
   * retries (Smart Retries) on its own schedule; our role for those is
   * purely reactive, via `handleStripeInvoicePaymentSucceeded/Failed` when
   * the corresponding webhook arrives. Charging a Stripe-backed subscription
   * from here too would double-bill it.
   *
   * Caller (`SchedulerService`) is responsible for wrapping this in a Redis
   * distributed lock so only one horizontally-scaled instance ever runs it
   * per tick — this method itself assumes it has exclusive ownership of the
   * `due` batch for the duration of the call.
   */
  async processRenewals(): Promise<{ processed: number; succeeded: number; failed: number; canceled: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      status: { $in: ['active', 'past_due'] },
      paymentProvider: 'manual',
      canceledAt: null, // a pending at-period-end cancellation should lapse, not renew
      nextBillingDate: { $lte: now },
      isDelete: false,
    });

    let succeeded = 0, failed = 0, canceled = 0;

    for (const sub of due) {
      try {
        const subId = (sub as any)._id.toString();

        // Apply any standing account credit (from a prior downgrade) before charging.
        const creditToApply = this.round(Math.min(sub.creditBalanceUSD ?? 0, sub.amountUSD));
        const chargeAmount = this.round(sub.amountUSD - creditToApply);

        const charge = chargeAmount > 0
          ? await this.gateway.chargeSubscription(subId, chargeAmount)
          : { success: true, providerChargeId: null as string | null, paymentMethodType: 'manual' }; // fully covered by credit — no real charge needed

        const invoice = await this.invoiceModel.create({
          subscriptionId: subId,
          storeId: sub.storeId,
          sellerId: sub.sellerId,
          customerId: sub.customerId,
          invoiceNumber: await this.generateInvoiceNumber(),
          type: 'recurring',
          amountUSD: chargeAmount,
          status: charge.success ? 'paid' : 'failed',
          paidAt: charge.success ? now : null,
          providerChargeId: charge.providerChargeId,
          paymentMethodType: (charge as any).paymentMethodType ?? 'manual',
          countryCode: sub.billingCountry ?? null,
        });

        await this.recordPaymentAttempt({
          subscriptionId: subId, storeId: sub.storeId, sellerId: sub.sellerId, customerId: sub.customerId,
          attemptType: 'renewal', outcome: charge.success ? 'success' : 'failed',
          amountUSD: chargeAmount,
          failureReason: charge.success ? null : ((charge as any).failureReason ?? 'Payment declined'),
          failureCode: (charge as any).failureCode ?? null,
          invoiceId: (invoice as any)._id.toString(), providerChargeId: charge.providerChargeId,
        });

        if (charge.success) {
          const periodEnd = this.addPeriod(now, sub.billingInterval as 'monthly' | 'yearly');
          sub.status = 'active';
          sub.currentPeriodStart = now;
          sub.currentPeriodEnd = periodEnd;
          sub.nextBillingDate = periodEnd;
          sub.totalPaidUSD = this.round(sub.totalPaidUSD + chargeAmount);
          sub.creditBalanceUSD = this.round((sub.creditBalanceUSD ?? 0) - creditToApply);
          sub.failedPaymentAttempts = 0;
          succeeded++;

          await sub.save();
          await this.creditSellerPayout(invoice);
          await this.grantCreditsIfApplicable(sub);

          if (creditToApply > 0) {
            this.activityLogService.log({
              storeId: sub.storeId, category: 'subscriptions', action: 'renewal_credit_applied',
              description: `$${creditToApply.toFixed(2)} account credit applied to renewal — $${chargeAmount.toFixed(2)} charged`,
              actorRole: 'system', targetId: subId, targetType: 'subscription',
            });
          }
        } else {
          const result = await this.applyDunningFailure(sub, chargeAmount);
          if (result.canceled) canceled++;
          failed++;
          await sub.save();
        }
      } catch (err: any) {
        // Never let one bad subscription break the whole batch.
        this.logger.error(`processRenewals: failed to process subscription ${(sub as any)._id}: ${err?.message}`);
        failed++;
      }
    }

    return { processed: due.length, succeeded, failed, canceled };
  }

  /** Finalizes subscriptions whose "cancel at period end" date has arrived. */
  async finalizeEndOfPeriodCancellations(): Promise<{ canceled: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      status: 'active',
      canceledAt: { $ne: null, $lte: now },
      isDelete: false,
    });

    for (const sub of due) {
      sub.status = 'canceled';
      await sub.save();
      // Stripe's own subscription would otherwise keep running past our local
      // period boundary and attempt its next renewal invoice — cancel it for
      // real at the same moment we finalize locally.
      if (sub.providerSubscriptionId) {
        await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
      }
      this.activityLogService.log({
        storeId: sub.storeId, category: 'subscriptions', action: 'subscription_canceled',
        description: `Subscription ${(sub as any)._id.toString()} canceled at period end`,
        actorRole: 'system', targetId: (sub as any)._id.toString(), targetType: 'subscription',
      });
    }

    return { canceled: due.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — BILLING SELF-SERVICE, BENEFITS, CREDITS, PREFERENCES, TIMELINE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Buyer adds/updates a card without an immediate charge (Stripe SetupIntent, confirmed client-side via Elements). */
  async createSetupIntent(customerId: string) {
    if (!this.gateway.isProviderDrivenBilling) {
      throw new BadRequestException('Payment method management requires the Stripe payment provider to be active');
    }
    const user = await this.db.repositories.userModel.findById(customerId);
    if (!user) throw new NotFoundException('Buyer account not found');

    if (!user.stripeCustomerId) {
      const { providerCustomerId } = await this.gateway.getOrCreateCustomer(customerId, user.email, user.name ?? '');
      user.stripeCustomerId = providerCustomerId;
      await user.save();
    }

    const result = await this.gateway.createSetupIntent(user.stripeCustomerId);
    return { success: true, data: result };
  }

  /** Stripe-hosted self-service portal — buyer manages payment methods and views invoices without any custom UI. */
  async createBillingPortalSession(customerId: string, returnUrl: string) {
    if (!this.gateway.isProviderDrivenBilling) {
      throw new BadRequestException('The billing portal requires the Stripe payment provider to be active');
    }
    const user = await this.db.repositories.userModel.findById(customerId);
    if (!user?.stripeCustomerId) {
      throw new BadRequestException('No billing account on file yet — subscribe to a plan first');
    }
    const result = await this.gateway.createBillingPortalSession(user.stripeCustomerId, returnUrl);
    return { success: true, data: result };
  }

  /** Every resolved benefit type for a buyer's active subscription at a given store, in one call — makes early_access/priority_support/credits consumable by any caller (frontend, other modules) without re-deriving the resolution logic. */
  async getBenefitsSummary(customerId: string, storeId: string) {
    const entry = await this.benefitsService.getActiveBenefits(customerId, storeId);
    if (!entry) return { success: true, data: { subscribed: false } };

    const [creditWallets] = await Promise.all([
      this.creditWalletModel.find({ customerId, storeId }).lean(),
    ]);

    const discountBenefit = entry.benefits.find((b: any) => b.type === 'discount' && b.enabled !== false);
    const earlyAccessBenefit = entry.benefits.find((b: any) => b.type === 'early_access' && b.enabled !== false);
    const prioritySupportBenefit = entry.benefits.find((b: any) => b.type === 'priority_support' && b.enabled !== false);
    const priorityBookingBenefit = entry.benefits.find((b: any) => b.type === 'priority_booking' && b.enabled !== false);

    return {
      success: true,
      data: {
        subscribed: true,
        planName: entry.planName,
        discount: discountBenefit ? { scope: discountBenefit.scope, discountPercent: discountBenefit.discountPercent, label: discountBenefit.label ?? null } : null,
        shipping: this.benefitsService.resolveShippingBenefit(entry.benefits),
        loyaltyMultiplier: this.benefitsService.getLoyaltyMultiplier(entry.benefits),
        earlyAccessHours: earlyAccessBenefit?.earlyAccessHours ?? null,
        hasPrioritySupport: !!prioritySupportBenefit,
        hasPriorityBooking: !!priorityBookingBenefit,
        credits: creditWallets.map((w: any) => ({ creditType: w.creditType, balance: w.balance, totalGranted: w.totalGranted })),
      },
    };
  }

  async getCreditWallets(customerId: string) {
    const wallets = await this.creditWalletModel.find({ customerId }).sort({ updatedAt: -1 }).lean();
    const storeIds = [...new Set(wallets.map((w: any) => w.storeId))];
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name logo slug').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));
    return { success: true, data: wallets.map((w: any) => ({ ...w, store: storeMap[w.storeId] ?? null })) };
  }

  /** Manual redemption of digital-download/service credits — the actual "spend" side of the `credits` benefit. */
  async spendCredit(customerId: string, storeId: string, creditType: 'download' | 'service', amount: number, reason: string) {
    if (amount <= 0) throw new BadRequestException('amount must be positive');
    const wallet = await this.creditWalletModel.findOne({ customerId, storeId, creditType });
    if (!wallet || wallet.balance < amount) throw new BadRequestException('Insufficient credit balance');

    wallet.balance = this.round(wallet.balance - amount);
    wallet.totalSpent = this.round(wallet.totalSpent + amount);
    wallet.ledger.push({ type: 'spend', amount: -amount, balanceAfter: wallet.balance, reason, referenceId: null, createdAt: new Date() });
    await wallet.save();

    return { success: true, data: wallet };
  }

  async getNotificationPreferences(customerId: string) {
    const prefs = await this.db.repositories.subscriptionNotificationPreferenceModel.findOne({ customerId }).lean();
    return {
      success: true,
      data: prefs ?? {
        customerId, renewalReminders: true, paymentFailedAlerts: true, prorationReceipts: true,
        cancellationConfirmations: true, planChangeUpdates: true, marketingTips: false,
      },
    };
  }

  async updateNotificationPreferences(customerId: string, dto: Partial<Record<string, boolean>>) {
    const updated = await this.db.repositories.subscriptionNotificationPreferenceModel.findOneAndUpdate(
      { customerId },
      { $set: { customerId, ...dto } },
      { upsert: true, new: true },
    );
    return { success: true, data: updated };
  }

  /** Chronological event feed for a single subscription (subscribe/renew/pause/resume/cancel/plan-change), sourced from the platform-wide activity log. */
  async getSubscriptionTimeline(customerId: string, subId: string) {
    await this.verifyMySub(customerId, subId);
    const events = await this.db.repositories.activityLogModel
      .find({ targetId: subId, targetType: 'subscription' })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return { success: true, data: events };
  }

  /** Sends "renews in N days" reminders and re-notifies buyers stuck in past_due. Runs every 6h via SchedulerService — dedupes per billing cycle via `renewalReminderSentAt`. */
  async sendRenewalReminders(): Promise<{ sent: number }> {
    const REMINDER_WINDOW_DAYS = 3;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const candidates = await this.subModel.find({
      status: 'active',
      canceledAt: null,
      nextBillingDate: { $gte: now, $lte: windowEnd },
      isDelete: false,
    });

    let sent = 0;
    for (const sub of candidates) {
      // Already reminded for this exact billing cycle.
      if (sub.renewalReminderSentAt && sub.renewalReminderSentAt >= sub.currentPeriodStart) continue;

      const [{ customerName, customerEmail, storeName }, plan] = await Promise.all([
        this.getCustomerAndStoreNames(sub.customerId, sub.storeId),
        this.planModel.findById(sub.planId).select('name').lean(),
      ]);
      if (!customerEmail) continue;

      const daysUntilRenewal = Math.max(0, Math.round((sub.nextBillingDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
      await this.queueEmail('sendRenewalReminder', customerEmail, {
        customerName, storeName, planName: (plan as any)?.name ?? 'your plan',
        amountUSD: sub.amountUSD, renewalDate: sub.nextBillingDate, daysUntilRenewal,
      }, sub.customerId);
      this.notificationsService.notify({
        recipientId: sub.customerId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.SUBSCRIPTION_RENEWAL_REMINDER,
        title: 'Membership renews soon',
        body: `Your ${storeName} membership renews in ${daysUntilRenewal} day${daysUntilRenewal === 1 ? '' : 's'}.`,
        data: { subscriptionId: String(sub._id) },
      }).catch(() => {});

      sub.renewalReminderSentAt = now;
      await sub.save();
      sent++;
    }

    return { sent };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRIPE WEBHOOK HANDLERS — called by StripeWebhookProcessor after signature
  // verification + idempotency-record insertion. Each handler independently
  // checks for its own duplicate-application case (Stripe can and does
  // redeliver events) before mutating anything.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Renewal (or initial) invoice paid — the actual "renewal succeeded" mechanism for Stripe-backed subscriptions. */
  @OnEvent('stripe.invoice.payment_succeeded')
  async handleStripeInvoicePaymentSucceeded(invoice: any): Promise<void> {
    const providerSubscriptionId: string | undefined = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (!providerSubscriptionId) return; // not a subscription invoice — nothing for us to do

    const sub = await this.subModel.findOne({ providerSubscriptionId, isDelete: false });
    if (!sub) {
      this.logger.warn(`invoice.payment_succeeded for unknown Stripe subscription ${providerSubscriptionId}`);
      return;
    }

    const alreadyRecorded = await this.invoiceModel.exists({ stripeInvoiceId: invoice.id });
    if (alreadyRecorded) return; // duplicate webhook delivery

    const amountUSD = this.round((invoice.amount_paid ?? 0) / 100);
    const line = invoice.lines?.data?.[0];
    const periodStart = line?.period?.start ? new Date(line.period.start * 1000) : new Date();
    const periodEnd = line?.period?.end ? new Date(line.period.end * 1000) : this.addPeriod(new Date(), sub.billingInterval as any);
    const providerChargeId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id ?? null;

    const invoiceDoc = await this.invoiceModel.create({
      subscriptionId: sub._id.toString(), storeId: sub.storeId, sellerId: sub.sellerId, customerId: sub.customerId,
      invoiceNumber: await this.generateInvoiceNumber(),
      type: invoice.billing_reason === 'subscription_create' ? 'initial' : 'recurring',
      amountUSD, status: 'paid', paidAt: new Date(),
      providerChargeId, stripeInvoiceId: invoice.id,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null, invoicePdfUrl: invoice.invoice_pdf ?? null,
      currency: invoice.currency ?? 'usd', paymentMethodType: 'card',
    });

    await this.recordPaymentAttempt({
      subscriptionId: sub._id.toString(), storeId: sub.storeId, sellerId: sub.sellerId, customerId: sub.customerId,
      attemptType: invoice.billing_reason === 'subscription_create' ? 'initial' : 'renewal',
      outcome: 'success', amountUSD, invoiceId: (invoiceDoc as any)._id.toString(),
      providerChargeId, stripePaymentIntentId: providerChargeId,
    });

    sub.status = 'active';
    sub.currentPeriodStart = periodStart;
    sub.currentPeriodEnd = periodEnd;
    sub.nextBillingDate = periodEnd;
    sub.totalPaidUSD = this.round(sub.totalPaidUSD + amountUSD);
    sub.failedPaymentAttempts = 0;
    sub.lastPaymentMethodType = 'card';
    await sub.save();

    await this.creditSellerPayout(invoiceDoc);
    await this.grantCreditsIfApplicable(sub);

    this.activityLogService.log({
      storeId: sub.storeId, category: 'subscriptions', action: 'subscription_renewed',
      description: `Stripe invoice ${invoice.id} paid — $${amountUSD.toFixed(2)}`,
      actorRole: 'system', targetId: sub._id.toString(), targetType: 'subscription',
    });
  }

  /** Renewal (or initial) invoice failed — the "renewal failed" / dunning mechanism for Stripe-backed subscriptions (Stripe's own Smart Retries drive the retry cadence; we just mirror the outcome). */
  @OnEvent('stripe.invoice.payment_failed')
  async handleStripeInvoicePaymentFailed(invoice: any): Promise<void> {
    const providerSubscriptionId: string | undefined = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (!providerSubscriptionId) return;

    const sub = await this.subModel.findOne({ providerSubscriptionId, isDelete: false });
    if (!sub) return;

    const amountUSD = this.round((invoice.amount_due ?? 0) / 100);
    const providerChargeId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id ?? null;

    await this.recordPaymentAttempt({
      subscriptionId: sub._id.toString(), storeId: sub.storeId, sellerId: sub.sellerId, customerId: sub.customerId,
      attemptType: invoice.billing_reason === 'subscription_create' ? 'initial' : 'renewal',
      outcome: 'failed', amountUSD,
      failureReason: 'Stripe invoice payment failed',
      providerChargeId, stripePaymentIntentId: providerChargeId,
    });

    // Stripe's own Smart Retries will keep retrying this invoice on Stripe's
    // schedule (up to the `subscription_next_attempt` it manages internally)
    // — we mirror the local status so benefits/dashboards reflect it now,
    // without racing Stripe's own eventual `customer.subscription.deleted`
    // (which we handle separately) once Stripe itself gives up.
    await this.applyDunningFailure(sub, amountUSD);
    await sub.save();
  }

  /** Keeps our local status/period roughly in sync with any change Stripe makes to the subscription directly (e.g. via the Billing Portal). */
  @OnEvent('stripe.customer.subscription.updated')
  async handleStripeSubscriptionUpdated(subscription: any): Promise<void> {
    const sub = await this.subModel.findOne({ providerSubscriptionId: subscription.id, isDelete: false });
    if (!sub) return;

    const statusMap: Record<string, string> = {
      active: 'active', trialing: 'active', past_due: 'past_due',
      unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled',
    };
    const mapped = statusMap[subscription.status];
    if (mapped && mapped !== sub.status) {
      sub.status = mapped;
      await sub.save();
    }
  }

  /** Stripe's own subscription object was deleted/canceled (e.g. after exhausting Smart Retries) — mirror it locally. */
  @OnEvent('stripe.customer.subscription.deleted')
  async handleStripeSubscriptionDeleted(subscription: any): Promise<void> {
    const sub = await this.subModel.findOne({ providerSubscriptionId: subscription.id, isDelete: false });
    if (!sub || sub.status === 'canceled') return;

    sub.status = 'canceled';
    sub.canceledAt = new Date();
    await sub.save();

    this.activityLogService.log({
      storeId: sub.storeId, category: 'subscriptions', action: 'subscription_canceled',
      description: `Subscription ${sub._id.toString()} canceled by Stripe (${subscription.cancellation_details?.reason ?? 'unspecified'})`,
      actorRole: 'system', targetId: sub._id.toString(), targetType: 'subscription',
    });
  }

  /** One-off PaymentIntent (proration top-up) succeeded asynchronously (e.g. after a 3DS challenge was completed). */
  @OnEvent('stripe.payment_intent.succeeded')
  async handleStripePaymentIntentSucceeded(paymentIntent: any): Promise<void> {
    const subscriptionId = paymentIntent.metadata?.internalSubscriptionId;
    if (!subscriptionId) return;
    await this.invoiceModel.updateMany(
      { subscriptionId, providerChargeId: paymentIntent.id, status: { $ne: 'paid' } },
      { $set: { status: 'paid', paidAt: new Date() } },
    );
  }

  /** One-off PaymentIntent (proration top-up) ultimately failed after requiring action. */
  @OnEvent('stripe.payment_intent.payment_failed')
  async handleStripePaymentIntentFailed(paymentIntent: any): Promise<void> {
    const subscriptionId = paymentIntent.metadata?.internalSubscriptionId;
    if (!subscriptionId) return;
    await this.invoiceModel.updateMany(
      { subscriptionId, providerChargeId: paymentIntent.id, status: { $ne: 'failed' } },
      { $set: { status: 'failed' } },
    );
  }
}
