/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PayoutScheduleDocument = PayoutSchedule & Document;

@Schema({ timestamps: true })
export class PayoutSchedule {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // A store can run a schedule per currency balance it holds (see
  // SellerBalance.currency) — a seller who takes both Stripe (USD) and
  // Pakistan manual-transfer (PKR) payments can set different cadences/
  // minimums for each.
  @Prop({ type: String, default: 'USD' }) currency: string;

  @Prop({
    type: String,
    enum: ['daily', 'weekly', 'biweekly', 'monthly', 'manual'],
    // Monthly by default (platform settles sellers once a month) — the
    // effective default for new schedules comes from AdminConfig
    // payoutConfig.payoutFrequency, see FinanceService.getOrCreateSchedule.
    default: 'monthly',
  })
  frequency: string;

  // For weekly: 0=Sun … 6=Sat (default 1 = Monday)
  @Prop({ type: Number, default: 1 }) dayOfWeek: number;
  // For monthly: 1–28
  @Prop({ type: Number, default: 1 }) dayOfMonth: number;

  // Minimum balance required to trigger auto payout
  @Prop({ type: Number, default: 50 }) minimumAmount: number;

  @Prop({ type: Boolean, default: true }) isEnabled: boolean;
  @Prop({ type: Date, default: null }) nextPayoutAt: Date | null;

  // Default payout method for auto payouts
  @Prop({ type: String, default: null }) defaultPayoutMethodId: string | null;
}

export const PayoutScheduleSchema = SchemaFactory.createForClass(PayoutSchedule);
PayoutScheduleSchema.index({ storeId: 1, currency: 1 }, { unique: true });
