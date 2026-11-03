/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionCounterDocument = SubscriptionCounter & Document;

/**
 * Atomic sequence counters, scoped by key (e.g. `invoice-202607`). Backs
 * invoice-number generation with a real atomic `$inc` instead of a random
 * suffix, so `invoiceNumber` collisions are structurally impossible rather
 * than merely unlikely. Now only used for seller platform-plan invoice numbers
 * (kept under its original name/collection so the existing sequence continues).
 */
@Schema({ timestamps: true, collection: 'subscription_counters' })
export class SubscriptionCounter {
  // `_id` is the counter key itself (e.g. `invoice-202607`). No `unique:`
  // here — MongoDB's built-in `_id` index already guarantees uniqueness, and
  // declaring a second index on `_id` triggers a Mongoose warning.
  @Prop({ type: String, required: true }) _id: string;
  @Prop({ type: Number, required: true, default: 0 }) seq: number;
}

export const SubscriptionCounterSchema = SchemaFactory.createForClass(SubscriptionCounter);
