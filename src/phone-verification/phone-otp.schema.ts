/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** One row per phone number being verified (throttling is per NUMBER). The code is stored only as an HMAC. */
@Schema({ timestamps: true, collection: 'phoneotps' })
export class PhoneOtp {
  @Prop({ type: String, required: true, unique: true }) phone: string;
  @Prop({ type: String, required: true, index: true }) userId: string;
  @Prop({ type: String, enum: ['user', 'seller'], required: true }) role: string;
  @Prop({ type: String, default: null }) codeHash: string | null;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  @Prop({ type: Number, default: 0 }) attempts: number;
  @Prop({ type: Date, default: null }) lastSentAt: Date | null;
  @Prop({ type: Date, default: null }) windowStart: Date | null;
  @Prop({ type: Number, default: 0 }) sendCount: number;
}
export type PhoneOtpDocument = PhoneOtp & Document;
export const PhoneOtpSchema = SchemaFactory.createForClass(PhoneOtp);
// Rows disappear a day after the last send (the hourly window is the longest thing we need to remember).
PhoneOtpSchema.index({ lastSentAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
