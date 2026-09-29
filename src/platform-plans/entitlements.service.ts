/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

export interface PlatformPlanLimits {
  maxProducts: number;
  maxStaffAccounts: number;
  maxPosLocations: number;
  aiCreditsPerMonth: number;
  transactionFeeRate: number;
  customDomainAllowed: boolean;
  whiteLabelAllowed: boolean;
  loyaltyProgramAllowed: boolean;
  subscriptionProductsAllowed: boolean;
  advancedAnalyticsAllowed: boolean;
  abandonedCartRecoveryAllowed: boolean;
  emailCampaignsAllowed: boolean;
  apiWebhooksAllowed: boolean;
  dedicatedAccountManager: boolean;
  prioritySupport: boolean;
  marketplaceFeaturedBadge: boolean;
  slaUptimePercent: number | null;
  advancedSeoToolsAllowed: boolean;
  seoAiSuggestionsAllowed: boolean;
  searchConsoleIntegrationAllowed: boolean;
  customRedirectsAllowed: boolean;
  maxActiveStoreBanners: number;
  maxActivePromotions: number;
}

// Used only as a last-resort fallback for a store that somehow has no
// SellerPlatformSubscription row at all AND no free plan exists yet in the
// DB (e.g. right after this feature is deployed, before an admin has
// created any PlatformPlan). Deliberately generous-but-not-unlimited so
// nothing breaks for existing stores during the rollout window.
const FALLBACK_LIMITS: PlatformPlanLimits = {
  maxProducts: 10, maxStaffAccounts: 0, maxPosLocations: 1, aiCreditsPerMonth: 0,
  transactionFeeRate: 0.08, customDomainAllowed: false, whiteLabelAllowed: false,
  loyaltyProgramAllowed: false, subscriptionProductsAllowed: false, advancedAnalyticsAllowed: false,
  abandonedCartRecoveryAllowed: false, emailCampaignsAllowed: false, apiWebhooksAllowed: false,
  dedicatedAccountManager: false, prioritySupport: false, marketplaceFeaturedBadge: false, slaUptimePercent: null,
  advancedSeoToolsAllowed: false, seoAiSuggestionsAllowed: false, searchConsoleIntegrationAllowed: false, customRedirectsAllowed: false,
  maxActiveStoreBanners: 4, maxActivePromotions: 1,
};

const BOOLEAN_FEATURES: Array<{ key: keyof PlatformPlanLimits; label: string }> = [
  { key: 'customDomainAllowed', label: 'Custom domain' },
  { key: 'whiteLabelAllowed', label: 'White-label branding' },
  { key: 'loyaltyProgramAllowed', label: 'Loyalty & rewards program' },
  { key: 'subscriptionProductsAllowed', label: 'Buyer subscription/membership plans' },
  { key: 'advancedAnalyticsAllowed', label: 'Advanced analytics' },
  { key: 'abandonedCartRecoveryAllowed', label: 'Abandoned cart recovery' },
  { key: 'emailCampaignsAllowed', label: 'Email campaigns' },
  { key: 'apiWebhooksAllowed', label: 'API access & webhooks' },
  { key: 'advancedSeoToolsAllowed', label: 'Advanced SEO tools (audit, score, checklist)' },
  { key: 'seoAiSuggestionsAllowed', label: 'AI-generated SEO suggestions' },
  { key: 'searchConsoleIntegrationAllowed', label: 'Search Console / Bing Webmaster integration' },
  { key: 'customRedirectsAllowed', label: 'Custom redirects & canonical overrides' },
];

/**
 * Central "what can this store do" resolver for the PlatformPlan system —
 * the same architectural role `SubscriptionBenefitsService` plays for the
 * buyer-facing VIP-plan system. Every module that needs to gate a feature
 * behind a platform tier (Products, Employee/staff, Store builder, Loyalty,
 * the buyer-subscription module itself, Finance's transaction fee) goes
 * through this one service so the limits are defined and enforced in
 * exactly one place.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DatabaseService) {}

  private get planModel() { return this.db.repositories.platformPlanModel; }
  private get subModel() { return this.db.repositories.sellerPlatformSubscriptionModel; }

  async getActivePlanForStore(storeId: string): Promise<{ subscription: any; plan: any } | null> {
    const subscription = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    if (!subscription) return null;
    const plan = await this.planModel.findById((subscription as any).platformPlanId).lean();
    if (!plan) return null;
    return { subscription, plan };
  }

  private async resolvePlan(storeId: string): Promise<any | null> {
    const result = await this.getActivePlanForStore(storeId);
    if (result) return result.plan;
    // No subscription row yet (store predates this feature, or auto-assign
    // hasn't run) — fall back to whichever plan is marked free, if any.
    return this.planModel.findOne({ isFree: true, status: 'active', isDelete: false }).lean();
  }

  async getLimits(storeId: string): Promise<PlatformPlanLimits> {
    const plan = await this.resolvePlan(storeId);
    return (plan?.limits as PlatformPlanLimits) ?? FALLBACK_LIMITS;
  }

  async getTransactionFeeRate(storeId: string): Promise<number> {
    const limits = await this.getLimits(storeId);
    return limits.transactionFeeRate ?? FALLBACK_LIMITS.transactionFeeRate;
  }

  /** Throws if the store is already at (or over) its product limit. Call BEFORE creating a new product. */
  async assertCanCreateProduct(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxProducts === -1) return;
    const count = await this.db.repositories.productModel.countDocuments({ storeId, isDelete: false });
    if (count >= limits.maxProducts) {
      throw new BadRequestException(
        `Product limit reached (${limits.maxProducts}) for your current plan — upgrade your platform plan to add more products.`,
      );
    }
  }

  /** Throws if the store already has its plan's limit of StoreBanner rows. Call BEFORE creating a new one.
   *  Deliberately counts ALL rows (not just `status:'active'`) — this is a plan-tier creation cap, distinct
   *  from `PlatformConfig.placementLimits.storeHero` which only bounds how many rotate on the storefront at once. */
  async assertCanCreateStoreBanner(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxActiveStoreBanners === -1) return;
    const count = await this.db.repositories.storeBannerModel.countDocuments({ storeId });
    if (count >= limits.maxActiveStoreBanners) {
      throw new BadRequestException(
        `Store banner limit reached (${limits.maxActiveStoreBanners}) for your current plan — upgrade your platform plan or delete an existing banner to add more.`,
      );
    }
  }

  /** Throws if the store already has its plan's limit of concurrently pending/approved/active PromotionRequests. */
  async assertCanCreatePromotion(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxActivePromotions === -1) return;
    const count = await this.db.repositories.promotionRequestModel.countDocuments({
      storeId, status: { $in: ['pending', 'approved', 'active'] },
    });
    if (count >= limits.maxActivePromotions) {
      throw new BadRequestException(
        `You already have ${limits.maxActivePromotions} promotion request(s) in progress — your current plan allows ${limits.maxActivePromotions} at a time. Upgrade your platform plan or wait for one to finish.`,
      );
    }
  }

  /** Generic boolean-feature gate — throws ForbiddenException with an upgrade hint if the store's plan doesn't include it. */
  async assertFeatureAllowed(storeId: string, feature: keyof PlatformPlanLimits, featureLabel: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (!limits[feature]) {
      const requiredPlan = await this.cheapestPlanWithFeature(feature);
      throw new ForbiddenException(
        `${featureLabel} is not included in your current platform plan${requiredPlan ? ` — available starting with the "${requiredPlan}" plan` : ''}.`,
      );
    }
  }

  private async cheapestPlanWithFeature(feature: keyof PlatformPlanLimits): Promise<string | null> {
    const plans = await this.planModel.find({ status: 'active', isDelete: false }).sort({ sortOrder: 1 }).lean();
    const match = plans.find((p: any) => p.limits?.[feature]);
    return match?.name ?? null;
  }

  /**
   * Full feature matrix for a store — what the frontend renders the pricing
   * table's "included / greyed-out with upgrade hint" UI from. One call, no
   * frontend business logic needed.
   */
  async getEntitlementsSummary(storeId: string) {
    const plan = await this.resolvePlan(storeId);
    const limits: PlatformPlanLimits = plan?.limits ?? FALLBACK_LIMITS;

    // POS (staff accounts, branch locations) was removed from Edudeen — the
    // keys stay in the summary with `used: 0` so existing dashboards that
    // render the pricing table keep working.
    const staffCount = 0;
    const posLocationCount = 0;
    const [productCount, aiWallet, allActivePlans] = await Promise.all([
      this.db.repositories.productModel.countDocuments({ storeId, isDelete: false }),
      this.db.repositories.aiCreditsWalletModel.findOne({ storeId }).lean(),
      this.planModel.find({ status: 'active', isDelete: false }).sort({ sortOrder: 1 }).lean(),
    ]);

    const cheapestWith = (feature: keyof PlatformPlanLimits) =>
      (allActivePlans as any[]).find((p) => p.limits?.[feature])?.name ?? null;

    const booleanFeatures: Record<string, { allowed: boolean; requiredPlan: string | null }> = {};
    for (const { key, label } of BOOLEAN_FEATURES) {
      booleanFeatures[key] = { allowed: !!limits[key], requiredPlan: limits[key] ? null : cheapestWith(key) };
      void label; // label is for assertFeatureAllowed's error message, not needed in the summary payload
    }

    return {
      currentPlanName: plan?.name ?? 'Starter (default)',
      currentPlanId: plan?._id?.toString?.() ?? null,
      maxProducts: {
        limit: limits.maxProducts, used: productCount,
        allowed: limits.maxProducts === -1 || productCount < limits.maxProducts,
      },
      maxStaffAccounts: {
        limit: limits.maxStaffAccounts, used: staffCount,
        allowed: limits.maxStaffAccounts === -1 || staffCount < limits.maxStaffAccounts,
      },
      maxPosLocations: {
        limit: limits.maxPosLocations, used: posLocationCount,
        allowed: limits.maxPosLocations === -1 || posLocationCount < limits.maxPosLocations,
      },
      aiCredits: {
        monthlyAllowance: limits.aiCreditsPerMonth,
        balance: (aiWallet as any)?.balance ?? 0,
      },
      transactionFeeRate: limits.transactionFeeRate,
      ...booleanFeatures,
      dedicatedAccountManager: !!limits.dedicatedAccountManager,
      prioritySupport: !!limits.prioritySupport,
      marketplaceFeaturedBadge: !!limits.marketplaceFeaturedBadge,
      slaUptimePercent: limits.slaUptimePercent ?? null,
    };
  }
}
