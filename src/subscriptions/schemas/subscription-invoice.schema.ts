/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionInvoiceDocument = SubscriptionInvoice & Document;

@Schema({ timestamps: true })
export class SubscriptionInvoice {
  @Prop({ type: String, required: true }) subscriptionId: string;
  @Prop({ type: String, required: true }) storeId: string;    // source of truth for ownership
  @Prop({ type: String, required: true }) sellerId: string;   // denormalized
  @Prop({ type: String, required: true }) customerId: string; // denormalized

  @Prop({ type: String, required: true, unique: true }) invoiceNumber: string;

  // 'initial' = first charge on subscribe, 'recurring' = billing-cycle
  // renewal, 'proration' = mid-cycle plan/interval change (may be negative
  // when the change results in an account credit rather than a charge).
  @Prop({ type: String, enum: ['initial', 'recurring', 'proration'], default: 'recurring' }) type: string;

  // Always USD — this is the canonical billing amount. Can be negative for
  // a 'proration' invoice that represents a credit issued, not a charge.
  @Prop({ type: Number, required: true }) amountUSD: number;

  // 'pending' is now a real, reachable state — a Stripe invoice can be created
  // and awaiting async payment confirmation (e.g. 3DS/SCA challenge) before
  // resolving to 'paid' or 'failed' via webhook.
  @Prop({ type: String, enum: ['paid', 'failed', 'pending', 'refunded', 'partially_refunded'], default: 'pending' }) status: string;

  @Prop({ type: Date, default: null }) paidAt: Date | null;
  @Prop({ type: Date, default: null }) refundedAt: Date | null;
  @Prop({ type: Number, default: 0 }) refundedAmountUSD: number;
  @Prop({ type: String, default: null }) providerRefundId: string | null;

  // Stripe charge/PaymentIntent id once integrated; null for the manual provider
  @Prop({ type: String, default: null }) providerChargeId: string | null;
  @Prop({ type: String, default: null }) stripeInvoiceId: string | null;
  @Prop({ type: String, default: null }) stripePaymentIntentId: string | null;
  @Prop({ type: String, default: null }) hostedInvoiceUrl: string | null;
  @Prop({ type: String, default: null }) invoicePdfUrl: string | null;

  @Prop({ type: String, default: 'usd' }) currency: string;
  @Prop({ type: String, default: null }) paymentMethodType: string | null; // 'card' | 'manual' | ...
  @Prop({ type: String, default: null }) countryCode: string | null;

  // ── Platform/seller revenue split (see PlatformCommissionService) ────────
  // Every OTHER revenue line in this platform (order sales, via
  // FinanceService.recordSale) splits into a seller-owed net amount + a
  // platform commission. Subscription revenue previously had NO split at all
  // (100% silently retained, seller never credited) — these two fields make
  // that split explicit and auditable per-invoice, and drive the seller's
  // actual SellerBalance credit (see SubscriptionsService.creditSellerPayout).
  @Prop({ type: Number, default: 0 }) platformCommissionUSD: number;
  @Prop({ type: Number, default: 0 }) sellerPayoutUSD: number;
  @Prop({ type: Boolean, default: false }) payoutCredited: boolean;

  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionInvoiceSchema = SchemaFactory.createForClass(SubscriptionInvoice);
SubscriptionInvoiceSchema.index({ subscriptionId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ storeId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ sellerId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ status: 1 });
SubscriptionInvoiceSchema.index({ stripeInvoiceId: 1 });
SubscriptionInvoiceSchema.index({ countryCode: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ paymentMethodType: 1, createdAt: -1 });
