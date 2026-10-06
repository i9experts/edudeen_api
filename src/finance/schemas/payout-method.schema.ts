import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PayoutMethodDocument = PayoutMethod & Document;

@Schema({ timestamps: true })
export class PayoutMethod {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({
    type: String,
    enum: ['bank_transfer', 'jazzcash', 'easypaisa', 'paypal', 'stripe'],
    required: true,
  })
  type: string;

  // Which of the seller's per-currency balances (see SellerBalance.currency)
  // this method pays out — bank_transfer/jazzcash/easypaisa default to PKR,
  // paypal/stripe default to USD, but a seller can still override (e.g. a
  // USD-denominated international bank account).
  @Prop({ type: String, default: 'USD' }) currency: string;

  @Prop({ type: Boolean, default: false }) isDefault: boolean;

  // Bank transfer / mobile wallet fields
  @Prop({ type: String, default: null }) bankName: string | null;
  @Prop({ type: String, default: null }) accountHolder: string | null;
  // Seller-facing screens only ever show the last 4 digits.
  @Prop({ type: String, default: null }) accountLast4: string | null;
  // Full account number / IBAN, AES-256-GCM encrypted at rest. Without it an admin
  // has nothing to pay the seller to. Never selected by default and never sent
  // to the seller — only the admin payout-destination endpoint decrypts it.
  @Prop({ type: String, default: null, select: false }) accountNumberEnc: string | null;
  @Prop({ type: String, default: null }) routingNumber: string | null;

  // Stripe / PayPal
  @Prop({ type: String, default: null }) externalAccountId: string | null;

  @Prop({
    type: String,
    enum: ['active', 'inactive', 'pending_verification'],
    default: 'pending_verification',
  })
  status: string;

  // Soft ownership-sanity check — does accountHolder reasonably match the
  // seller's registered name? Never blocks the seller from adding/using the
  // method; only surfaces a review hint on the admin payout-method list.
  @Prop({ type: Boolean, default: false }) accountTitleMismatchFlagged: boolean;
  @Prop({ type: String, default: null }) accountTitleMismatchNote: string | null;

  // Admin verification audit trail — who moved this method to 'active' (or
  // back to 'inactive'/'pending_verification') and when.
  @Prop({ type: String, default: null }) verifiedByAdminId: string | null;
  @Prop({ type: Date, default: null }) verifiedAt: Date | null;
}

export const PayoutMethodSchema = SchemaFactory.createForClass(PayoutMethod);
PayoutMethodSchema.index({ storeId: 1 });
PayoutMethodSchema.index({ storeId: 1, isDefault: 1 });
PayoutMethodSchema.index({ status: 1 });
