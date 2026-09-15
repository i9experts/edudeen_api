/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreatePlatformPlanDto } from './dto/create-platform-plan.dto';
import { UpdatePlatformPlanDto } from './dto/update-platform-plan.dto';

const DEFAULT_LIMITS = {
  maxProducts: 10, maxStaffAccounts: 0, maxPosLocations: 1, aiCreditsPerMonth: 0,
  transactionFeeRate: 0.03, customDomainAllowed: false, whiteLabelAllowed: false,
  loyaltyProgramAllowed: false, subscriptionProductsAllowed: false, advancedAnalyticsAllowed: false,
  abandonedCartRecoveryAllowed: false, emailCampaignsAllowed: false, apiWebhooksAllowed: false,
  dedicatedAccountManager: false, prioritySupport: false, marketplaceFeaturedBadge: false, slaUptimePercent: null,
};

/** Admin CRUD + public browse for PlatformPlan — the tiers on the pricing page. */
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get planModel() { return this.db.repositories.platformPlanModel; }
  private get subModel() { return this.db.repositories.sellerPlatformSubscriptionModel; }

  private round(n: number) { return Math.round(n * 100) / 100; }

  // ── Admin ──────────────────────────────────────────────────────────────

  async adminCreatePlan(adminId: string, dto: CreatePlatformPlanDto) {
    if (!dto.isFree && !dto.isCustomPricing && dto.monthlyPriceUSD == null) {
      throw new BadRequestException('monthlyPriceUSD is required unless the plan is free or custom-priced');
    }

    const plan = await this.planModel.create({
      name: dto.name,
      description: dto.description ?? null,
      badge: dto.badge ?? null,
      sortOrder: dto.sortOrder ?? 0,
      isFree: dto.isFree ?? false,
      isCustomPricing: dto.isCustomPricing ?? false,
      monthlyPriceUSD: dto.monthlyPriceUSD != null ? this.round(dto.monthlyPriceUSD) : null,
      yearlyPriceUSD: dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null,
      trialDays: dto.trialDays ?? 0,
      featureBullets: dto.featureBullets ?? [],
      limits: { ...DEFAULT_LIMITS, ...dto.limits },
      status: 'active',
      isPubliclyVisible: dto.isPubliclyVisible ?? true,
    });

    this.activityLogService.log({
      category: 'platform_plans', action: 'plan_created',
      description: `Platform plan "${plan.name}" created by admin`,
      actorId: adminId, actorRole: 'admin',
      targetId: (plan as any)._id.toString(), targetType: 'platform_plan',
    });

    return { success: true, data: plan };
  }

  async adminListPlans(includeArchived: boolean) {
    const filter: any = { isDelete: false };
    if (!includeArchived) filter.status = 'active';
    const plans = await this.planModel.find(filter).sort({ sortOrder: 1 }).lean();

    const subscriberCounts = await this.subModel.aggregate([
      { $match: { isDelete: false } },
      { $group: { _id: '$platformPlanId', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(subscriberCounts.map((r: any) => [r._id, r.count]));

    return { success: true, data: plans.map((p: any) => ({ ...p, subscriberCount: countMap[p._id.toString()] ?? 0 })) };
  }

  async adminGetPlanById(id: string) {
    const plan = await this.planModel.findOne({ _id: id, isDelete: false }).lean();
    if (!plan) throw new NotFoundException('Platform plan not found');
    return { success: true, data: plan };
  }

  async adminUpdatePlan(adminId: string, id: string, dto: UpdatePlatformPlanDto) {
    const plan = await this.planModel.findOne({ _id: id, isDelete: false });
    if (!plan) throw new NotFoundException('Platform plan not found');

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description ?? null;
    if (dto.badge !== undefined) plan.badge = dto.badge ?? null;
    if (dto.sortOrder !== undefined) plan.sortOrder = dto.sortOrder;
    if (dto.isFree !== undefined) plan.isFree = dto.isFree;
    if (dto.isCustomPricing !== undefined) plan.isCustomPricing = dto.isCustomPricing;
    if (dto.monthlyPriceUSD !== undefined) {
      plan.monthlyPriceUSD = dto.monthlyPriceUSD != null ? this.round(dto.monthlyPriceUSD) : null;
      // Price changed — cached Stripe Price ids are now stale (Stripe Prices are
      // immutable); clear them so the next subscribe/renewal lazily creates fresh ones.
      plan.stripeMonthlyPriceId = null;
    }
    if (dto.yearlyPriceUSD !== undefined) {
      plan.yearlyPriceUSD = dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null;
      plan.stripeYearlyPriceId = null;
    }
    if (dto.trialDays !== undefined) plan.trialDays = dto.trialDays;
    if (dto.featureBullets !== undefined) plan.featureBullets = dto.featureBullets;
    if (dto.limits !== undefined) plan.limits = { ...plan.limits, ...dto.limits } as any;
    if (dto.status !== undefined) plan.status = dto.status;
    if (dto.isPubliclyVisible !== undefined) plan.isPubliclyVisible = dto.isPubliclyVisible;

    await plan.save();

    this.activityLogService.log({
      category: 'platform_plans', action: 'plan_updated',
      description: `Platform plan "${plan.name}" updated by admin`,
      actorId: adminId, actorRole: 'admin',
      targetId: id, targetType: 'platform_plan',
    });

    return { success: true, data: plan };
  }

  async adminArchivePlan(adminId: string, id: string, force: boolean) {
    const plan = await this.planModel.findOne({ _id: id, isDelete: false });
    if (!plan) throw new NotFoundException('Platform plan not found');
    if (plan.isFree) throw new BadRequestException('The free/default plan cannot be archived');

    const activeCount = await this.subModel.countDocuments({ platformPlanId: id, status: { $in: ['trialing', 'active', 'past_due'] } });
    if (activeCount > 0 && !force) {
      throw new BadRequestException(
        `This plan has ${activeCount} store(s) currently on it. Pass ?force=true to archive anyway (existing stores are unaffected).`,
      );
    }

    plan.status = 'archived';
    await plan.save();

    this.activityLogService.log({
      category: 'platform_plans', action: 'plan_archived',
      description: `Platform plan "${plan.name}" archived by admin`,
      actorId: adminId, actorRole: 'admin',
      targetId: id, targetType: 'platform_plan',
    });

    return { success: true, message: `Plan archived. ${activeCount} existing store(s) unaffected.` };
  }

  async adminGetSubscribers(id: string, query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const [subs, total] = await Promise.all([
      this.subModel.find({ platformPlanId: id, isDelete: false }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments({ platformPlanId: id, isDelete: false }),
    ]);

    const storeIds = subs.map((s: any) => s.storeId);
    const stores = await this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: {
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        subscribers: subs.map((s: any) => ({ ...s, store: storeMap[s.storeId] ?? null })),
      },
    };
  }

  /** Platform-plan revenue — a completely separate line item from buyer-VIP-plan subscription revenue and order commission. */
  async adminGetRevenue(query: any) {
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : new Date();

    const [totalAgg, byPlanRaw, activeByPlan, activeSubs] = await Promise.all([
      this.db.repositories.platformPlanInvoiceModel.aggregate([
        { $match: { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
      ]),
      this.db.repositories.platformPlanInvoiceModel.aggregate([
        { $match: { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$platformPlanId', total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      this.subModel.aggregate([
        { $match: { isDelete: false, status: { $in: ['trialing', 'active', 'past_due'] } } },
        { $group: { _id: '$platformPlanId', count: { $sum: 1 } } },
      ]),
      // MRR/ARR — a live snapshot of currently-recurring revenue, not a
      // date-range sum of past invoices (that's totalRevenueUSD/byPlan below).
      this.subModel.find({
        isDelete: false, status: { $in: ['active', 'past_due'] }, amountUSD: { $gt: 0 },
      }).select('platformPlanId amountUSD billingInterval').lean(),
    ]);

    const planIds = [...new Set([...byPlanRaw.map((r: any) => r._id), ...activeByPlan.map((r: any) => r._id), ...activeSubs.map((s: any) => s.platformPlanId)])];
    const plans = await this.planModel.find({ _id: { $in: planIds } }).select('name isFree').lean();
    const planMap = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p]));
    const activeCountMap = Object.fromEntries(activeByPlan.map((r: any) => [r._id, r.count]));

    const monthlyAmount = (s: any) => (s.billingInterval === 'yearly' ? s.amountUSD / 12 : s.amountUSD);
    const mrr = this.round(activeSubs.reduce((sum: number, s: any) => sum + monthlyAmount(s), 0));
    const mrrByPlan = new Map<string, number>();
    for (const s of activeSubs) {
      mrrByPlan.set(s.platformPlanId, (mrrByPlan.get(s.platformPlanId) ?? 0) + monthlyAmount(s));
    }

    const activeSubscribersCount = await this.subModel.countDocuments({
      isDelete: false, status: { $in: ['trialing', 'active', 'past_due'] },
    });

    return {
      success: true,
      data: {
        mrr,
        arr: this.round(mrr * 12),
        activeSubscribers: activeSubscribersCount,
        planBreakdown: Object.keys(activeCountMap).map((planId) => ({
          planName: planMap[planId]?.name ?? 'Unknown',
          subscriberCount: activeCountMap[planId] ?? 0,
          mrrUSD: this.round(mrrByPlan.get(planId) ?? 0),
        })),
        totalRevenueUSD: this.round(totalAgg[0]?.total ?? 0),
        totalInvoicesPaid: totalAgg[0]?.count ?? 0,
        byPlan: byPlanRaw.map((r: any) => ({
          planId: r._id, planName: planMap[r._id]?.name ?? 'Unknown',
          revenueUSD: this.round(r.total), invoiceCount: r.count,
          currentActiveStores: activeCountMap[r._id] ?? 0,
        })),
        note: 'This is platform-plan (seller-to-Edudeen) revenue — a separate line item from buyer-VIP-plan subscription revenue (SubscriptionInvoice) and order commission (FinanceService).',
      },
    };
  }

  // ── Public ─────────────────────────────────────────────────────────────

  async browsePlans() {
    // `isPubliclyVisible` defaults to true on new plans, but existing plans created
    // before this field existed have it entirely absent in Mongo (not backfilled) —
    // `{ $ne: false }` matches both `true` and "field missing", so no migration is
    // needed and no pre-existing plan silently disappears from the pricing page.
    const plans = await this.planModel.find({ status: 'active', isPubliclyVisible: { $ne: false }, isDelete: false }).sort({ sortOrder: 1 }).lean();
    return {
      success: true,
      data: plans.map((p: any) => ({
        _id: p._id, name: p.name, description: p.description, badge: p.badge,
        isFree: p.isFree, isCustomPricing: p.isCustomPricing,
        monthlyPriceUSD: p.monthlyPriceUSD, yearlyPriceUSD: p.yearlyPriceUSD, trialDays: p.trialDays,
        featureBullets: p.featureBullets, limits: p.limits,
      })),
    };
  }
}
