/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** Admin-managed "Edudeen Premium" buyer plan. Prices are stored in USD (like PlatformPlan) and shown in PKR via FX. */
@Schema({ timestamps: true })
export class PremiumPlan {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, default: '' }) description: string;
  @Prop({ type: Number, required: true, min: 0 }) monthlyPriceUSD: number;
  /** null = 12 x monthly. */
  @Prop({ type: Number, default: null }) yearlyPriceUSD: number | null;
  @Prop({ type: Boolean, default: true }) isActive: boolean;
  @Prop({ type: Number, default: 0 }) sortOrder: number;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;

  @Prop({
    type: Object,
    default: () => ({ childrenLimit: 15, earlyAccessHours: 2, monthlyCouponValue: 0, monthlyCouponType: 'percentage', prioritySupport: true }),
  })
  benefits: PremiumBenefits;
}
export interface PremiumBenefits {
  childrenLimit: number;
  earlyAccessHours: number;
  /** 0 = no monthly coupon. Platform-funded (the seller is credited the full price). */
  monthlyCouponValue: number;
  monthlyCouponType: 'percentage' | 'fixed';
  prioritySupport: boolean;
}
export type PremiumPlanDocument = PremiumPlan & Document;
export const PremiumPlanSchema = SchemaFactory.createForClass(PremiumPlan);
PremiumPlanSchema.index({ isActive: 1, isDelete: 1, sortOrder: 1 });

export const MEMBERSHIP_STATUSES = ['active', 'expired', 'cancelled', 'pending'] as const;

/** One row per buyer. */
@Schema({ timestamps: true })
export class PremiumMembership {
  @Prop({ type: String, required: true }) userId: string;
  @Prop({ type: String, required: true }) planId: string;
  /** Frozen copy of the plan's name + benefits at purchase/grant time, so edits to the plan never change a running membership. */
  @Prop({ type: Object, default: null }) planSnapshot: { name: string; benefits: PremiumBenefits } | null;
  @Prop({ type: String, enum: MEMBERSHIP_STATUSES, default: 'pending' }) status: string;
  @Prop({ type: String, enum: ['monthly', 'yearly'], default: 'monthly' }) interval: string;
  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) currentPeriodEnd: Date | null;
  @Prop({ type: String, enum: ['bank_transfer', 'admin_grant', 'stripe'], default: 'bank_transfer' }) source: string;
  @Prop({ type: Boolean, default: false }) cancelAtPeriodEnd: boolean;
  @Prop({ type: Date, default: null }) expiringNotifiedFor: Date | null;
  @Prop({ type: Date, default: null }) expiredNotifiedAt: Date | null;
}
export type PremiumMembershipDocument = PremiumMembership & Document;
export const PremiumMembershipSchema = SchemaFactory.createForClass(PremiumMembership);
PremiumMembershipSchema.index({ userId: 1 }, { unique: true });
PremiumMembershipSchema.index({ status: 1, currentPeriodEnd: 1 });

/** A bank-transfer purchase of (an extension of) Premium: created by subscribe, proof uploaded, admin approves/rejects. */
@Schema({ timestamps: true })
export class PremiumPayment {
  @Prop({ type: String, required: true }) userId: string;
  @Prop({ type: String, required: true }) planId: string;
  @Prop({ type: String, default: '' }) planName: string;
  @Prop({ type: String, enum: ['monthly', 'yearly'], required: true }) interval: string;
  @Prop({ type: Number, required: true }) amountUSD: number;
  @Prop({ type: Number, default: null }) amountPKR: number | null;
  @Prop({ type: Number, default: null }) fxRateUsed: number | null;
  /** awaiting_proof: created, nothing uploaded yet. pending: proof uploaded, admin review. */
  @Prop({ type: String, enum: ['awaiting_proof', 'pending', 'approved', 'rejected', 'cancelled'], default: 'awaiting_proof' }) status: string;
  @Prop({ type: String, default: null }) proofPublicId: string | null;
  @Prop({ type: String, default: null }) proofResourceType: string | null;
  @Prop({ type: String, default: null }) transactionReference: string | null;
  @Prop({ type: String, default: null }) senderName: string | null;
  @Prop({ type: Object, default: null }) receiptCheck: Record<string, any> | null;
  @Prop({ type: String, default: null }) reviewedByAdminId: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;
  @Prop({ type: Number, default: 0 }) reuploadCount: number;
}
export type PremiumPaymentDocument = PremiumPayment & Document;
export const PremiumPaymentSchema = SchemaFactory.createForClass(PremiumPayment);
PremiumPaymentSchema.index({ userId: 1, createdAt: -1 });
PremiumPaymentSchema.index({ status: 1, createdAt: 1 });

/** Idempotency ledger for the once-a-month member coupon. */
@Schema({ timestamps: true })
export class PremiumCouponIssue {
  @Prop({ type: String, required: true }) userId: string;
  /** 'YYYY-MM' (UTC). */
  @Prop({ type: String, required: true }) month: string;
  @Prop({ type: String, required: true }) code: string;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
}
export type PremiumCouponIssueDocument = PremiumCouponIssue & Document;
export const PremiumCouponIssueSchema = SchemaFactory.createForClass(PremiumCouponIssue);
PremiumCouponIssueSchema.index({ userId: 1, month: 1 }, { unique: true });
/** Single admin-owned settings row (key 'default'): the platform-funded offer, the fee on premium sales and the sale/premium gap. */
@Schema({ timestamps: true })
export class PremiumSettings {
  @Prop({ type: String, required: true, default: 'default' }) key: string;
  @Prop({ type: Object, default: () => ({ enabled: true, percent: 5 }) }) platformDiscount: { enabled: boolean; percent: number };
  @Prop({ type: Number, default: 5 }) premiumSellerFeePercent: number;
  @Prop({ type: Number, default: 5 }) minGapPercent: number;
  @Prop({ type: String, default: null }) updatedByAdminId: string | null;
}
export type PremiumSettingsDocument = PremiumSettings & Document;
export const PremiumSettingsSchema = SchemaFactory.createForClass(PremiumSettings);
PremiumSettingsSchema.index({ key: 1 }, { unique: true });