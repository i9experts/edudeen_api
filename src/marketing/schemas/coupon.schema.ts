import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CouponDocument = Coupon & Document;

@Schema({ timestamps: true })
export class Coupon {
  // 'platform' coupons (admin-issued, e.g. WELCOME10) have no single store —
  // storeId/sellerId stay null and the code is looked up globally instead.
  @Prop({ type: String, enum: ['seller', 'platform'], default: 'seller' })
  scope: 'seller' | 'platform';

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, default: null })
  sellerId: string | null;

  // set only for scope: 'platform' — which admin created it
  @Prop({ type: String, default: null })
  adminId: string | null;

  @Prop({ required: true, uppercase: true, trim: true })
  code: string;

  @Prop({ required: true, enum: ['percentage', 'fixed'] })
  discountType: 'percentage' | 'fixed';

  @Prop({ required: true })
  discountValue: number;

  // Only meaningful when discountType === 'fixed' (a 'percentage' value is
  // scale-free and needs no currency). For scope:'seller' coupons this is
  // the issuing store's own Store.baseCurrency; for scope:'platform'
  // coupons this is always 'USD' (the platform pivot — see
  // ExchangeRateService). Nullable at the schema level so pre-existing
  // fixed-value coupons (created before this field existed, back when
  // Checkout.currency was implicitly always 'USD') remain valid — the
  // one-time backfill sets any existing fixed-type coupon's currency to
  // 'USD' to match that historical implicit assumption exactly, not a
  // guess.
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: Number, default: null })
  minOrderAmount: number | null;

  @Prop({ type: Number, default: null })
  usageLimit: number | null;

  @Prop({ type: Number, default: 0 })
  usageCount: number;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;

  // Personal coupon: only this buyer may redeem it (Edudeen Premium monthly coupon). null = anyone.
  @Prop({ type: String, default: null })
  ownerUserId: string | null;

  // true = the discount is funded by the platform; the seller is credited the full price.
  @Prop({ type: Boolean, default: false })
  platformFunded: boolean;
}

export const CouponSchema = SchemaFactory.createForClass(Coupon);

// Uniqueness is scope-specific: a seller's code only needs to be unique within
// their own store; a platform code (storeId null) must be unique globally.
CouponSchema.index(
  { storeId: 1, code: 1 },
  { unique: true, partialFilterExpression: { scope: 'seller' } },
);
CouponSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { scope: 'platform' } },
);
CouponSchema.index({ storeId: 1, isActive: 1 });
