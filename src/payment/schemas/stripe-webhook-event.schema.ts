import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StripeWebhookEventDocument = HydratedDocument<StripeWebhookEvent>;

// Dedup record for the order/checkout Stripe webhook (payment.controller.ts
// stripeWebhook route) — brings it up to the same replay-safety standard
// the subscription-billing webhook already has (see
// subscriptions/schemas/webhook-event.schema.ts, which this deliberately
// does NOT reuse, to keep the two webhook paths decoupled). A unique index
// on `eventId` means a redelivered Stripe event fails to insert here and is
// treated as an already-processed no-op, independent of whatever
// incidental protection the PaymentTransaction status-transition guard
// happens to provide.
@Schema({ timestamps: true })
export class StripeWebhookEvent {
  @Prop({ type: String, required: true, unique: true })
  eventId: string;

  @Prop({ type: String, required: true })
  eventType: string;

  createdAt?: Date;
}

export const StripeWebhookEventSchema = SchemaFactory.createForClass(StripeWebhookEvent);
