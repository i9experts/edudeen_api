/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationPreferenceDocument = NotificationPreference & Document;

@Schema({ _id: false })
class PrefFlags {
  @Prop({ default: true })
  orders: boolean;

  @Prop({ default: true })
  messages: boolean;

  @Prop({ default: true })
  promotions: boolean;

  @Prop({ default: true })
  loyalty: boolean;

  @Prop({ default: true })
  subscriptions: boolean;

  @Prop({ default: true })
  finance: boolean;
}

const PrefFlagsSchema = SchemaFactory.createForClass(PrefFlags);

@Schema({ timestamps: true })
export class NotificationPreference {
  @Prop({ required: true, unique: true })
  userId: string;

  @Prop({ required: true, enum: ['user', 'seller', 'admin'] })
  role: string;

  @Prop({ type: PrefFlagsSchema, default: () => ({}) })
  prefs: PrefFlags;

  @Prop({ default: true })
  pushEnabled: boolean;

  @Prop({ default: true })
  emailEnabled: boolean;

  // Out-of-app channels are OPT-IN (default off). See notifications/channels.
  @Prop({ default: false })
  whatsappEnabled: boolean;

  @Prop({ default: false })
  smsEnabled: boolean;

  // Separate opt-in for retention messages (cart reminder, price/stock alerts, referral rewards) over WhatsApp/SMS.
  @Prop({ default: false })
  retentionChannelsEnabled: boolean;

  // Language of WhatsApp/SMS messages.
  @Prop({ type: String, enum: ['en', 'ur'], default: 'en' })
  language: string;
}

export const NotificationPreferenceSchema = SchemaFactory.createForClass(NotificationPreference);
