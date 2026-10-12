/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SaleCreditJobDocument = SaleCreditJob & Document;
export type SaleCreditJobStatus = 'pending' | 'done' | 'failed_final';

/**
 * Durable outbox for seller sale credits. One row per (order, store). It is written BEFORE
 * FinanceService.recordSale runs, so a crash/failure after the buyer paid always leaves a
 * `pending` row that the retry cron (or an admin) can finish. recordSale is idempotent per
 * (order, store), so retrying is always safe.
 */
@Schema({ timestamps: true, collection: 'sale_credit_jobs' })
export class SaleCreditJob {
  @Prop({ type: String, required: true }) orderId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  /** The exact recordSale arguments (amounts, currency, fee items, frozen fxSnapshots...). */
  @Prop({ type: Object, required: true }) payload: Record<string, any>;
  @Prop({ type: String, enum: ['pending', 'done', 'failed_final'], default: 'pending' }) status: SaleCreditJobStatus;
  @Prop({ type: Number, default: 0 }) attempts: number;
  @Prop({ type: String, default: null }) lastError: string | null;
  @Prop({ type: Date, default: () => new Date() }) nextAttemptAt: Date;
  @Prop({ type: Date, default: null }) alertedAt: Date | null;
  @Prop({ type: Date, default: null }) doneAt: Date | null;
}

export const SaleCreditJobSchema = SchemaFactory.createForClass(SaleCreditJob);
SaleCreditJobSchema.index({ orderId: 1, storeId: 1 }, { unique: true });
SaleCreditJobSchema.index({ status: 1, nextAttemptAt: 1 });
