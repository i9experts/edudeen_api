/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformConfigDocument = PlatformConfig & Document;

@Schema({ _id: false })
export class FeatureFlags {
  @Prop({ type: Boolean, default: true }) aiStudio: boolean;
  @Prop({ type: Boolean, default: true }) marketplace: boolean;
  @Prop({ type: Boolean, default: true }) digitalUploads: boolean;
  @Prop({ type: Boolean, default: false }) affiliateProgram: boolean;
  @Prop({ type: Boolean, default: false }) giftCards: boolean;
  @Prop({ type: Boolean, default: true }) posMode: boolean;
  @Prop({ type: Boolean, default: true }) storeBuilder: boolean;
  @Prop({ type: Boolean, default: false }) bulkProductImport: boolean;
  @Prop({ type: Boolean, default: true }) promotions: boolean;
  // Unreleased — unlike the flags above (which default true/on for an
  // already-shipped feature), a brand-new feature defaults off until QA'd.
  @Prop({ type: Boolean, default: false }) storefrontBlog: boolean;
}
export const FeatureFlagsSchema = SchemaFactory.createForClass(FeatureFlags);

// How many banners are simultaneously visible/rotating per placement — deliberately
// NOT a create-time cap (rows are unlimited); this only bounds the read-side
// `.limit()` so an oversubscribed placement rotates instead of overflowing the UI.
@Schema({ _id: false })
export class PlacementLimits {
  @Prop({ type: Number, default: 4 }) homepageHero: number;
  @Prop({ type: Number, default: 4 }) marketplaceHero: number;
  @Prop({ type: Number, default: 4 }) educationHero: number;
  @Prop({ type: Number, default: 4 }) categoryHero: number;
  @Prop({ type: Number, default: 4 }) storeHero: number;
  @Prop({ type: Number, default: 8 }) storeFeaturedProducts: number;
}
export const PlacementLimitsSchema = SchemaFactory.createForClass(PlacementLimits);

@Schema({ _id: false })
export class AiConfig {
  @Prop({ type: Number, default: 1000 }) monthlyCreditLimit: number;
  @Prop({ type: String, default: 'claude-sonnet-5' }) aiModel: string;
}
export const AiConfigSchema = SchemaFactory.createForClass(AiConfig);

@Schema({ _id: false })
export class PayoutConfig {
  // Minimum available-balance amount required to gate both an on-demand
  // "Withdraw" action and the scheduled auto-payout batch — kept per
  // currency since Pakistan (manual bank/JazzCash/Easypaisa transfer) and
  // international (Stripe) sellers hold separate balances (see
  // SellerBalance.currency) with very different order-of-magnitude minimums.
  @Prop({ type: Number, default: 5 }) minPayoutUSD: number;
  @Prop({ type: Number, default: 1500 }) minPayoutPKR: number;
}
export const PayoutConfigSchema = SchemaFactory.createForClass(PayoutConfig);

// The Pakistan "pay into the platform's own bank account, upload proof"
// track (see manual-payments module) — buyer-visible company account details
// plus the USD→PKR rate used to convert an order's USD-priced total into the
// PKR amount the buyer actually transfers. Admin-managed so it can be updated
// without a deploy; `enabled: false` hides the option from checkout entirely.
@Schema({ _id: false })
export class ManualPaymentConfig {
  @Prop({ type: Boolean, default: false }) enabled: boolean;

  @Prop({ type: String, default: null }) bankName: string | null;
  @Prop({ type: String, default: null }) accountTitle: string | null;
  @Prop({ type: String, default: null }) accountNumber: string | null;
  @Prop({ type: String, default: null }) iban: string | null;
  @Prop({ type: String, default: null }) jazzcashNumber: string | null;
  @Prop({ type: String, default: null }) easypaisaNumber: string | null;
  @Prop({ type: String, default: null }) instructions: string | null;

  // How many PKR one USD converts to — applied to a checkout's USD total at
  // the moment the buyer commits to this payment method (not live-fetched
  // from a market-rate API, since there's no automated FX integration here;
  // an admin updates this periodically). See PaymentService.manualBankTransferPayment.
  @Prop({ type: Number, default: 278 }) usdToPkrRate: number;
}
export const ManualPaymentConfigSchema = SchemaFactory.createForClass(ManualPaymentConfig);

// Operational settings for the single authoritative PKR/USD (and later
// EUR/GBP/...) exchange rate source — see ExchangeRateService and the
// `exchangerates` collection it owns. This config holds only *how* rates
// get refreshed/flagged, never the rate value itself (that's the append-only
// ExchangeRate history, not a singleton field, so a full audit trail and
// "which orders used rate X" traceability are possible).
@Schema({ _id: false })
export class FxConfig {
  @Prop({ type: Boolean, default: true }) autoRefreshEnabled: boolean;
  @Prop({ type: Number, default: 24 }) refreshIntervalHours: number;
  @Prop({ type: Number, default: 48 }) staleRateAlertThresholdHours: number;
  // A newly-ingested rate outside [min,max] for its currency is rejected
  // outright (not persisted as current) — guards against a malformed/zero/
  // negative provider response.
  @Prop({ type: Number, default: 150 }) sanityBandMinPKR: number;
  @Prop({ type: Number, default: 450 }) sanityBandMaxPKR: number;
  // A newly-ingested rate that's within the sane band but moved more than
  // this percent from the current rate is held (isRejected: true, visible
  // in history) rather than auto-promoted — an admin must confirm it
  // explicitly. Deliberately more cautious than "auto-apply + alert": once
  // an order is created against a rate it's immutable forever, so a bad
  // automatic promotion can't be walked back the way a held one can.
  @Prop({ type: Number, default: 8 }) abnormalJumpAlertPercent: number;
  // Platform-wide open FX exposure ceiling (USD-equivalent, summed across
  // every non-USD currency's pending-settlement balance — see
  // AdminFinanceService#getFxExposure). A daily cron compares the current
  // exposure against this and raises a security alert on breach; this does
  // NOT trigger any automatic hedging/trading, just visibility.
  @Prop({ type: Number, default: 50_000 }) exposureThresholdUSD: number;
}
export const FxConfigSchema = SchemaFactory.createForClass(FxConfig);

@Schema({ _id: false })
export class EmailConfig {
  @Prop({ type: String, default: 'Edudeen' }) fromName: string;
  @Prop({ type: String, default: null }) fromEmail: string | null;
  @Prop({ type: String, default: null }) replyToEmail: string | null;
  @Prop({ type: String, default: 'SendGrid' }) provider: string;
}
export const EmailConfigSchema = SchemaFactory.createForClass(EmailConfig);

// Singleton collection — exactly one document ever exists, fetched/updated via
// upsert with an empty filter (see AdminConfigService), same convention used
// for other platform-wide single-doc settings in this codebase.
@Schema({ timestamps: true })
export class PlatformConfig {
  @Prop({ type: Boolean, default: false })
  maintenanceMode: boolean;

  @Prop({ type: FeatureFlagsSchema, default: () => ({}) })
  featureFlags: FeatureFlags;

  @Prop({ type: AiConfigSchema, default: () => ({}) })
  aiConfig: AiConfig;

  @Prop({ type: EmailConfigSchema, default: () => ({}) })
  emailConfig: EmailConfig;

  @Prop({ type: PlacementLimitsSchema, default: () => ({}) })
  placementLimits: PlacementLimits;

  // Untyped, like `PlatformPlan.limits` — a per-placement rate card needs to stay
  // freely extensible (new tiers, festival overrides) without a schema migration.
  // Shape: { [placement]: { hourly, daily, weekly, monthly, weekendMultiplier,
  // peakMultiplier, festivalOverrides: [{ name, startAt, endAt, rate }] } }
  @Prop({ type: Object, default: () => ({}) })
  promotionPricing: Record<string, unknown>;
  @Prop({ type: PayoutConfigSchema, default: () => ({}) })
  payoutConfig: PayoutConfig;

  @Prop({ type: ManualPaymentConfigSchema, default: () => ({}) })
  manualPaymentConfig: ManualPaymentConfig;

  @Prop({ type: FxConfigSchema, default: () => ({}) })
  fxConfig: FxConfig;
}

export const PlatformConfigSchema = SchemaFactory.createForClass(PlatformConfig);
