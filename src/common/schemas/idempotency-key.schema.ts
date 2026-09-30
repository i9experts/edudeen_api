/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type IdempotencyRecordDocument = IdempotencyRecord & Document;

/**
 * Generic idempotency-key ledger (`Idempotency-Key` request header) — reusable
 * across any mutating endpoint, not just Subscriptions. Guards against duplicate
 * charges/subscriptions/plan-changes when a client retries a timed-out request
 * (mobile network drop, double-tap, load-balancer retry).
 */
@Schema({ timestamps: true })
export class IdempotencyRecord {
  @Prop({ type: String, required: true, unique: true }) key: string;
  @Prop({ type: String, required: true }) requesterId: string;
  @Prop({ type: String, required: true }) route: string;
  @Prop({ type: String, enum: ['in_progress', 'completed'], default: 'in_progress' }) status: string;
  @Prop({ type: Number, default: null }) responseStatusCode: number | null;
  @Prop({ type: Object, default: null }) responseBody: Record<string, any> | null;
  // TTL — idempotency guarantees only need to hold for the retry window (client
  // retry storms are seconds-to-minutes, not days), so records expire automatically.
  @Prop({ type: Date, required: true }) expiresAt: Date;
}

export const IdempotencyRecordSchema = SchemaFactory.createForClass(IdempotencyRecord);
IdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
