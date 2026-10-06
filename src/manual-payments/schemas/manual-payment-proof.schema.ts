/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ManualPaymentProofDocument = ManualPaymentProof & Document;

/**
 * The Pakistan "pay into the platform's own company bank account, upload
 * proof" track — one row per checkout attempt. The order(s) are created
 * immediately (paymentStatus: 'pending_verification', isPaid: false, same as
 * COD's "place now, settle later" shape) and only marked paid once an admin
 * approves the proof here — see ManualPaymentsService.
 */
@Schema({ timestamps: true })
export class ManualPaymentProof {
  @Prop({ type: String, required: true }) userId: string;
  @Prop({ type: String, required: true }) checkoutId: string;
  @Prop({ type: [String], default: [] }) orderIds: string[];
  // Store whose seller received this transfer and confirms it (null on legacy, platform-account proofs).
  @Prop({ type: String, default: null }) storeId: string | null;

  // Snapshot of the amount at submission time — the USD figure is the
  // checkout's own total (source of truth for pricing everywhere else in
  // the app); the PKR figure is what the buyer was told to actually
  // transfer, computed from `fxRateUsed` at that moment.
  @Prop({ type: Number, required: true }) amountUSD: number;
  @Prop({ type: Number, required: true }) amountPKR: number;
  @Prop({ type: Number, required: true }) fxRateUsed: number;

  // Legacy proofs were uploaded publicly and only have `proofImageUrl`. New
  // proofs are private: `proofPublicId` (+ resource type) is the source of
  // truth and a short-lived signed URL is minted on read.
  @Prop({ type: String, default: null }) proofImageUrl: string | null;
  @Prop({ type: String, default: null }) proofPublicId: string | null;
  @Prop({ type: String, default: null }) proofResourceType: string | null;
  @Prop({ type: String, default: null }) transactionReference: string | null;
  @Prop({ type: String, default: null }) senderName: string | null;

  @Prop({
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  })
  status: string;

  // Audit trail — who reviewed it, when, and why (on reject).
  @Prop({ type: String, default: null }) reviewedByAdminId: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;

  // Incremented each time the buyer re-uploads after a rejection — lets
  // admins see "this is their 3rd attempt" at a glance.
  @Prop({ type: Number, default: 0 }) reuploadCount: number;
}

export const ManualPaymentProofSchema = SchemaFactory.createForClass(ManualPaymentProof);
ManualPaymentProofSchema.index({ userId: 1, createdAt: -1 });
ManualPaymentProofSchema.index({ checkoutId: 1 });
ManualPaymentProofSchema.index({ status: 1, createdAt: 1 });
