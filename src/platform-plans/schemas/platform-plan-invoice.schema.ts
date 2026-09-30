/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformPlanInvoiceDocument = PlatformPlanInvoice & Document;

/** Billing record for a store's platform-plan charge — mirrors SubscriptionInvoice's shape for the buyer-billing system. */
@Schema({ timestamps: true })
export class PlatformPlanInvoice {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) platformPlanId: string;

  @Prop({ type: String, required: true, unique: true }) invoiceNumber: string;
  @Prop({ type: String, enum: ['initial', 'recurring', 'proration'], default: 'recurring' }) type: string;

  @Prop({ type: Number, required: true }) amountUSD: number;
  @Prop({ type: String, enum: ['paid', 'failed', 'pending', 'refunded', 'partially_refunded'], default: 'pending' }) status: string;
  @Prop({ type: Date, default: null }) paidAt: Date | null;
  @Prop({ type: Date, default: null }) refundedAt: Date | null;
  @Prop({ type: Number, default: 0 }) refundedAmountUSD: number;
  @Prop({ type: String, default: null }) providerRefundId: string | null;

  @Prop({ type: String, default: null }) providerChargeId: string | null;
  @Prop({ type: String, default: null }) stripeInvoiceId: string | null;
  @Prop({ type: String, default: null }) hostedInvoiceUrl: string | null;
  @Prop({ type: String, default: null }) invoicePdfUrl: string | null;
  @Prop({ type: String, default: null }) paymentMethodType: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const PlatformPlanInvoiceSchema = SchemaFactory.createForClass(PlatformPlanInvoice);
PlatformPlanInvoiceSchema.index({ storeId: 1, createdAt: -1 });
PlatformPlanInvoiceSchema.index({ status: 1 });
PlatformPlanInvoiceSchema.index({ stripeInvoiceId: 1 });
