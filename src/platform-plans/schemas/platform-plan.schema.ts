/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformPlanDocument = PlatformPlan & Document;

/**
 * Admin-managed platform access tier (Starter/Professional/Business/Enterprise
 * on the pricing page) — what a SELLER pays EDUDEEN for platform access,
 * scoped per STORE (not per seller account: a seller with multiple stores can
 * put each on a different tier — see SellerPlatformSubscription).
 *
 * This is a completely separate system from `SubscriptionPlan` (the buyer-
 * facing VIP/membership plans a seller builds for their own customers) —
 * different collection, different subscribers, different money flow.
 */
@Schema({ timestamps: true })
export class PlatformPlan {
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: String, default: null }) badge: string | null; // e.g. "Popular" / "Recommended"
  @Prop({ type: Number, default: 0 }) sortOrder: number;
  // Lets an admin keep a plan assignable (e.g. a negotiated legacy/grandfathered
  // tier) without it appearing on the public pricing page's self-serve list —
  // distinct from `status`, which controls whether the plan can be used at all.
  @Prop({ type: Boolean, default: true }) isPubliclyVisible: boolean;

  // ── Billing ───────────────────────────────────────────────────────────────
  @Prop({ type: Boolean, default: false }) isFree: boolean;
  // Enterprise-style "Contact Sales" — no self-serve checkout, no fixed price.
  @Prop({ type: Boolean, default: false }) isCustomPricing: boolean;
  @Prop({ type: Number, default: null }) monthlyPriceUSD: number | null;
  @Prop({ type: Number, default: null }) yearlyPriceUSD: number | null;
  @Prop({ type: Number, default: 0 }) trialDays: number;

  @Prop({ type: [String], default: [] }) featureBullets: string[]; // marketing copy only, cosmetic

  // ── Server-enforced limits/entitlements — the real mechanism ─────────────
  @Prop({
    type: Object,
    required: true,
    default: () => ({
      maxProducts: 10,
      maxStaffAccounts: 0,
      maxPosLocations: 1,
      aiCreditsPerMonth: 0,
      transactionFeeRate: 0.03,
      customDomainAllowed: false,
      whiteLabelAllowed: false,
      loyaltyProgramAllowed: false,
      subscriptionProductsAllowed: false, // gates the buyer-facing VIP-plan module
      advancedAnalyticsAllowed: false,
      abandonedCartRecoveryAllowed: false,
      emailCampaignsAllowed: false,
      apiWebhooksAllowed: false,
      dedicatedAccountManager: false,
      prioritySupport: false,
      marketplaceFeaturedBadge: false,
      slaUptimePercent: null,
      advancedSeoToolsAllowed: false,
      seoAiSuggestionsAllowed: false,
      searchConsoleIntegrationAllowed: false,
      customRedirectsAllowed: false,
    }),
  })
  limits: {
    maxProducts: number;              // -1 = unlimited
    maxStaffAccounts: number;         // -1 = unlimited
    maxPosLocations: number;
    aiCreditsPerMonth: number;
    transactionFeeRate: number;       // e.g. 0.03 = 3% — replaces FinanceService's flat PLATFORM_FEE_RATE
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
    advancedSeoToolsAllowed: boolean;      // gates SEO Audit, Score Engine, Technical Checklist automation
    seoAiSuggestionsAllowed: boolean;      // gates AI-generated meta suggestions (consumes AiCreditsWallet)
    searchConsoleIntegrationAllowed: boolean; // gates per-store Google Search Console / Bing Webmaster connection
    customRedirectsAllowed: boolean;       // gates seller-managed redirect rules & canonical overrides
  };

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: string;
  @Prop({ default: false }) isDelete: boolean;

  // Stripe catalog mirror — same lazy-creation pattern as SubscriptionPlan.
  @Prop({ type: String, default: null }) stripeProductId: string | null;
  @Prop({ type: String, default: null }) stripeMonthlyPriceId: string | null;
  @Prop({ type: String, default: null }) stripeYearlyPriceId: string | null;
}

export const PlatformPlanSchema = SchemaFactory.createForClass(PlatformPlan);
PlatformPlanSchema.index({ status: 1, sortOrder: 1 });
PlatformPlanSchema.index({ isFree: 1 });
