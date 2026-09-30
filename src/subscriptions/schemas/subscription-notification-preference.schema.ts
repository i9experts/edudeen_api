/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionNotificationPreferenceDocument = SubscriptionNotificationPreference & Document;

/** Per-buyer email preferences for subscription/billing notifications. Defaults to everything on. */
@Schema({ timestamps: true })
export class SubscriptionNotificationPreference {
  @Prop({ type: String, required: true, unique: true }) customerId: string;

  @Prop({ type: Boolean, default: true }) renewalReminders: boolean;
  @Prop({ type: Boolean, default: true }) paymentFailedAlerts: boolean;
  @Prop({ type: Boolean, default: true }) prorationReceipts: boolean;
  @Prop({ type: Boolean, default: true }) cancellationConfirmations: boolean;
  @Prop({ type: Boolean, default: true }) planChangeUpdates: boolean;
  @Prop({ type: Boolean, default: false }) marketingTips: boolean;
}

export const SubscriptionNotificationPreferenceSchema = SchemaFactory.createForClass(SubscriptionNotificationPreference);
