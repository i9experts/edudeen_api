/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PROMOTION_PLACEMENTS, PromotionPlacement } from '../../common/promotion-placements.const';

export type PromotionRequestDocument = HydratedDocument<PromotionRequest>;

export const PROMOTION_REQUEST_STATUSES = [
  'draft', 'pending', 'approved', 'rejected', 'active', 'paused', 'expired', 'cancelled',
] as const;
export type PromotionRequestStatus = (typeof PROMOTION_REQUEST_STATUSES)[number];

export const PROMOTION_PAYMENT_STATUSES = ['pending', 'paid', 'refunded', 'failed'] as const;
export type PromotionPaymentStatus = (typeof PROMOTION_PAYMENT_STATUSES)[number];

export const PROMOTION_LINK_TYPES = ['product', 'category', 'external', 'collection'] as const;
export type PromotionLinkType = (typeof PROMOTION_LINK_TYPES)[number];

@Schema({ timestamps: true })
export class PromotionRequest {
  _id: string;

  @Prop({ required: true, index: true })
  sellerId: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, enum: PROMOTION_PLACEMENTS, required: true })
  placement: PromotionPlacement;

  @Prop({ required: true })
  creativeUrl: string;

  @Prop({ default: '' })
  creativePublicId: string;

  @Prop({ type: String, default: null })
  mobileCreativeUrl: string | null;

  @Prop({ default: '' })
  mobileCreativePublicId: string;

  @Prop({ type: String, default: null })
  ctaLabel: string | null;

  @Prop({ type: String, enum: PROMOTION_LINK_TYPES, default: 'external' })
  linkType: PromotionLinkType;

  @Prop({ type: String, default: null })
  linkTarget: string | null;

  @Prop({ type: String, default: null })
  message: string | null;

  @Prop({ required: true })
  startAt: Date;

  @Prop({ required: true })
  endAt: Date;

  @Prop({ required: true })
  priceUSD: number;

  @Prop({ type: Object, default: {} })
  pricingBreakdown: Record<string, unknown>;

  @Prop({ type: String, enum: PROMOTION_PAYMENT_STATUSES, default: 'pending' })
  paymentStatus: PromotionPaymentStatus;

  @Prop({ type: String, default: null })
  stripePaymentIntentId: string | null;

  @Prop({ type: String, enum: PROMOTION_REQUEST_STATUSES, default: 'draft' })
  status: PromotionRequestStatus;

  @Prop({ type: String, default: null })
  rejectionReason: string | null;

  @Prop({ type: String, default: null })
  reviewedBy: string | null;

  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  // Guards the "expiring soon" notification against re-firing every cron tick.
  @Prop({ type: Date, default: null })
  expiringSoonNotifiedAt: Date | null;

  /** USD actually refunded to the seller (full, pro-rated on cancel, or a late-payment auto-refund). */
  @Prop({ default: 0 })
  refundedUSD: number;

  // Populated once approved+paid — the Banner row this request actually
  // produces, so admin's Banner placement management and this request stay
  // in sync (one direct creation, not a second reconciliation process).
  @Prop({ type: String, default: null })
  resultingBannerId: string | null;

  // Priority/order this promotion competes with among others active in the
  // same placement — same rotation convention as Banner.order/Campaign.order.
  @Prop({ default: 0 })
  order: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PromotionRequestSchema = SchemaFactory.createForClass(PromotionRequest);

PromotionRequestSchema.index({ placement: 1, status: 1, startAt: 1, endAt: 1 });
PromotionRequestSchema.index({ sellerId: 1, createdAt: -1 });
PromotionRequestSchema.index({ status: 1, endAt: 1 });
