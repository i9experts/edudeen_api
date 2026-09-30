/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SellerPlatformSubscriptionDocument = SellerPlatformSubscription & Document;

/**
 * One store's subscription to a PlatformPlan. Scoped by `storeId` (source of
 * truth), `sellerId` denormalized for the cross-store Seller Overview
 * Dashboard — exact same pattern as the buyer-facing `Subscription` schema,
 * deliberately, for consistency across the codebase's two subscription systems.
 */
@Schema({ timestamps: true, optimisticConcurrency: true })
export class SellerPlatformSubscription {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) platformPlanId: string;

  @Prop({ type: String, enum: ['monthly', 'yearly'], default: 'monthly' }) billingInterval: string;
  @Prop({ type: Number, required: true }) amountUSD: number; // snapshot, immune to later plan price edits

  @Prop({
    type: String,
    enum: ['trialing', 'active', 'past_due', 'canceled'],
    default: 'trialing',
  })
  status: string;

  @Prop({ type: Date, required: true }) startedAt: Date;
  @Prop({ type: Date, default: null }) trialEndsAt: Date | null;
  @Prop({ type: Boolean, default: false }) trialReminderSent: boolean;
  @Prop({ type: Date, required: true }) currentPeriodStart: Date;
  @Prop({ type: Date, required: true }) currentPeriodEnd: Date;
  @Prop({ type: Date, required: true }) nextBillingDate: Date;
  @Prop({ type: Date, default: null }) canceledAt: Date | null;
  // "Cancel Subscription" schedules a downgrade to the free plan at currentPeriodEnd
  // rather than revoking paid access mid-period the seller already paid for — the
  // same convention Stripe/Shopify/Paddle all use. finalizeScheduledCancellations()
  // executes it once the period actually ends; reactivateSubscription() undoes it.
  @Prop({ type: Boolean, default: false }) cancelAtPeriodEnd: boolean;
  @Prop({ type: String, default: null }) cancelReason: string | null;

  @Prop({ type: Number, default: 0 }) totalPaidUSD: number;
  @Prop({ type: Number, default: 0 }) failedPaymentAttempts: number;
  @Prop({ type: Number, default: 0 }) creditBalanceUSD: number;

  @Prop({ type: [Object], default: [] }) planHistory: Array<{
    fromPlanId: string; fromPlanName: string; toPlanId: string; toPlanName: string;
    proratedAmountUSD: number; changedAt: Date;
  }>;

  @Prop({ type: String, enum: ['manual', 'stripe'], default: 'manual' }) paymentProvider: string;
  @Prop({ type: String, default: null }) providerSubscriptionId: string | null;
  // A paid-plan purchase that is waiting for Stripe to confirm payment. Entitlements keep
  // following `platformPlanId` (the CURRENT plan) until the invoice is actually paid —
  // abandoning the payment sheet must not grant the paid plan.
  @Prop({ type: Object, default: null }) pendingPlanChange: {
    platformPlanId: string; billingInterval: string; amountUSD: number;
    providerSubscriptionId: string; historyEntry: Record<string, unknown>; requestedAt: Date;
  } | null;
  @Prop({ type: String, default: null }) stripeCustomerId: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const SellerPlatformSubscriptionSchema = SchemaFactory.createForClass(SellerPlatformSubscription);
SellerPlatformSubscriptionSchema.index({ storeId: 1 }, { unique: true }); // one active platform plan per store, ever
SellerPlatformSubscriptionSchema.index({ sellerId: 1 });
SellerPlatformSubscriptionSchema.index({ platformPlanId: 1 });
SellerPlatformSubscriptionSchema.index({ nextBillingDate: 1, status: 1 });
SellerPlatformSubscriptionSchema.index({ providerSubscriptionId: 1 });
SellerPlatformSubscriptionSchema.index({ 'pendingPlanChange.providerSubscriptionId': 1 }, { sparse: true });
