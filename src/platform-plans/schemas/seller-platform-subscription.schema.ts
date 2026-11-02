/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { syncStoreListings } from '../plan-listing-sync.util';

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
  // Free time-limited access given by an admin (no charge). Expires via expireComplimentary();
  // any plan change by the seller clears it.
  @Prop({ type: Object, default: null }) complimentary: {
    until: Date; grantedBy: string; reason: string | null; grantedAt: Date; days: number;
  } | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const SellerPlatformSubscriptionSchema = SchemaFactory.createForClass(SellerPlatformSubscription);
// Whenever the plan status is saved, hide (expired) or restore (any other status) the store's listings.
// Best effort: a failure here is caught by the periodic reconcile in SchedulerService.
SellerPlatformSubscriptionSchema.post('save', async function (doc: any) {
  try {
    if (!doc?.storeId) return;
    await syncStoreListings(doc.model('Product'), String(doc.storeId), doc.status);
  } catch {
    /* reconciled by cron */
  }
});
// Same for query-style updates (updateOne/updateMany/findOneAndUpdate): remember the affected stores
// before the write, re-read their status after it. Capped so a broad filter can't fan out.
async function syncAfterQueryUpdate(query: any, storeIds: string[]) {
  const subModel = query.model;
  for (const storeId of storeIds) {
    const sub: any = await subModel.findOne({ storeId }).select('status').lean();
    if (sub) await syncStoreListings(subModel.db.model('Product'), storeId, sub.status);
  }
}
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  SellerPlatformSubscriptionSchema.pre(op, async function (this: any) {
    try {
      const rows = await this.model.find(this.getFilter()).select('storeId').limit(100).lean();
      this._planSyncStores = rows.map((r: any) => String(r.storeId));
    } catch { this._planSyncStores = []; }
  });
  SellerPlatformSubscriptionSchema.post(op, async function (this: any) {
    try { await syncAfterQueryUpdate(this, this._planSyncStores ?? []); } catch { /* reconciled by cron */ }
  });
}
SellerPlatformSubscriptionSchema.index({ storeId: 1 }, { unique: true }); // one active platform plan per store, ever
SellerPlatformSubscriptionSchema.index({ sellerId: 1 });
SellerPlatformSubscriptionSchema.index({ platformPlanId: 1 });
SellerPlatformSubscriptionSchema.index({ nextBillingDate: 1, status: 1 });
SellerPlatformSubscriptionSchema.index({ providerSubscriptionId: 1 });
SellerPlatformSubscriptionSchema.index({ 'pendingPlanChange.providerSubscriptionId': 1 }, { sparse: true });
