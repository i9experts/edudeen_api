import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GiftCardDocument = GiftCard & Document;

/**
 * A store-scoped, balance-based credit — unlike a Coupon (single-use,
 * flat/percentage, no real money attached), a GiftCard holds actual value
 * that can be spent across multiple orders until its balance reaches zero.
 * Two ways one comes into existence (`issuedBy`): a buyer pays real money
 * for one (`GiftCardsService.createPurchaseIntent`/`finalizeGiftCardPurchase`),
 * or a seller issues one directly with no purchase (e.g. a goodwill/service
 * credit) via `GiftCardsService.issueManual`.
 */
@Schema({ timestamps: true })
export class GiftCard {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true, uppercase: true, trim: true })
  code: string;

  // The issuing store's own baseCurrency — a gift card is only ever
  // redeemable at the store that issued it, so there is no cross-currency
  // conversion concern the way a platform-wide Coupon has.
  @Prop({ required: true })
  currency: string;

  @Prop({ required: true })
  initialValue: number;

  @Prop({ required: true })
  balance: number;

  @Prop({ type: String, enum: ['active', 'disabled', 'expired'], default: 'active' })
  status: 'active' | 'disabled' | 'expired';

  @Prop({ type: String, enum: ['purchase', 'manual'], default: 'manual' })
  issuedBy: 'purchase' | 'manual';

  // Set only when issuedBy === 'purchase' — who paid for it.
  @Prop({ type: String, default: null })
  purchaserUserId: string | null;

  @Prop({ type: String, default: null })
  recipientEmail: string | null;

  @Prop({ type: String, default: null })
  recipientName: string | null;

  @Prop({ type: String, default: null })
  message: string | null;

  // Set only when issuedBy === 'manual' — which seller/admin issued it, for
  // the activity log / accountability trail.
  @Prop({ type: String, default: null })
  issuedByUserId: string | null;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  // Checkouts that already debited this card. Part of the SAME atomic update
  // as the debit (see GiftCardsService.redeemAtOrderPlacement), which is what
  // makes a concurrent retry for one checkout debit exactly once.
  @Prop({ type: [String], default: [] })
  redeemedCheckoutIds: string[];

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const GiftCardSchema = SchemaFactory.createForClass(GiftCard);

GiftCardSchema.index({ storeId: 1, code: 1 }, { unique: true });
GiftCardSchema.index({ storeId: 1, status: 1 });
GiftCardSchema.index({ purchaserUserId: 1 });
