import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CampaignDocument = Campaign & Document;

// Platform-wide sale event (e.g. "Summer Sale Weekend") created by admin.
// Sellers opt individual stores in via participatingStoreIds — separate from
// a seller's own store-level Coupon, which stays entirely under their control.
@Schema({ timestamps: true })
export class Campaign {
  @Prop({ required: true })
  name: string;

  // URL-safe handle for the ?campaign= query param on the marketplace
  // listing page — generated once at creation (see
  // AdminMarketingService.createCampaign).
  @Prop({ type: String, unique: true, sparse: true })
  slug: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  bannerImage: string | null;

  @Prop({ required: true })
  startDate: Date;

  @Prop({ required: true })
  endDate: Date;

  @Prop({ type: String, enum: ['draft', 'active', 'ended'], default: 'draft' })
  status: string;

  // optional platform-suggested default discount sellers can apply when opting in
  @Prop({ type: String, enum: ['percentage', 'fixed'], default: null })
  discountType: 'percentage' | 'fixed' | null;

  @Prop({ type: Number, default: null })
  discountValue: number | null;

  // Only meaningful when discountType === 'fixed' (a 'percentage' value is
  // scale-free and needs no currency). Campaigns are always admin-created
  // platform-wide events, so this is always 'USD' (the platform pivot — see
  // ExchangeRateService) — same convention as Coupon.currency for
  // scope:'platform' coupons. Nullable so pre-existing fixed-value campaigns
  // (created before this field existed) remain valid; treat null as 'USD'.
  @Prop({ type: String, default: 'USD' })
  currency: string | null;

  // Who actually bears the cost of the discount:
  // - 'seller' (default, existing behavior): the discount comes straight out of
  //   the participating seller's own payout — same as a seller's own Coupon.
  // - 'platform': the platform reimburses the seller for the discounted amount
  //   at sale time (see FinanceService.recordSale), so a participating seller's
  //   payout is unaffected — the buyer still sees the same lower price, the
  //   platform absorbs the difference instead of the seller.
  @Prop({ type: String, enum: ['seller', 'platform'], default: 'seller' })
  sponsorType: 'seller' | 'platform';

  // Running total of what this campaign has cost the platform in sponsored
  // discounts so far (only ever non-zero for sponsorType: 'platform') — kept
  // in lockstep with the ledger via the same $inc call that writes the
  // corresponding Transaction (see FinanceService.recordSale), so it can
  // never drift from the auditable transaction history it summarizes.
  @Prop({ type: Number, default: 0 })
  totalPlatformSubsidyUSD: number;

  @Prop({ type: [String], default: [] })
  participatingStoreIds: string[];

  // Controls rotation order in the buyer-facing DealsBanner when multiple
  // campaigns are active at once (0 = shown first) — same convention as
  // Banner.order. Admin-set, independent of endDate/createdAt.
  @Prop({ type: Number, default: 0 })
  order: number;

  @Prop({ type: String, default: null })
  createdBy: string | null;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);

CampaignSchema.index({ status: 1, startDate: 1, endDate: 1 });
