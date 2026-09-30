/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WebhookEventDocument = WebhookEvent & Document;

/**
 * One row per received Stripe webhook event (`evt_...`). Stripe explicitly
 * documents that the same event can be delivered more than once (retries,
 * duplicate listeners) — `providerEventId` is unique so a duplicate delivery
 * is detected and skipped (idempotent processing / replay protection) instead
 * of double-applying a renewal or double-crediting a seller payout.
 */
@Schema({ timestamps: true })
export class WebhookEvent {
  @Prop({ type: String, required: true, enum: ['stripe'] }) provider: string;
  @Prop({ type: String, required: true, unique: true }) providerEventId: string;
  @Prop({ type: String, required: true }) type: string;
  @Prop({ type: String, enum: ['received', 'processing', 'processed', 'failed', 'ignored'], default: 'received' })
  status: string;
  @Prop({ type: Object, default: null }) payload: Record<string, any> | null;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: Number, default: 0 }) processingAttempts: number;
  @Prop({ type: Date, default: null }) processedAt: Date | null;
}

export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);
WebhookEventSchema.index({ provider: 1, status: 1, createdAt: -1 });
WebhookEventSchema.index({ type: 1, createdAt: -1 });
