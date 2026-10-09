/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AiStudioSettingDocument = AiStudioSetting & Document;

/** Per-store AI Studio preferences. Everything here is OFF by default (opt-in). */
@Schema({ timestamps: true, collection: 'ai_studio_settings' })
export class AiStudioSetting {
  @Prop({ type: String, required: true, unique: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: Boolean, default: false })
  weeklyDigestEnabled: boolean;

  @Prop({ type: Date, default: null })
  weeklyDigestEnabledAt: Date | null;

  /** ISO week key (e.g. 2026-W41) of the last digest that was generated for this store. */
  @Prop({ type: String, default: null })
  weeklyDigestLastWeek: string | null;

  @Prop({ type: Date, default: null })
  weeklyDigestLastRunAt: Date | null;

  /** True after we told the seller (once) that a digest was skipped for lack of credits; cleared on the next success. */
  @Prop({ type: Boolean, default: false })
  weeklyDigestSkipNotified: boolean;

  /** Do not retry before this time (set after a skip so we do not hammer the wallet every hour). */
  @Prop({ type: Date, default: null })
  weeklyDigestNextTryAt: Date | null;
}

export const AiStudioSettingSchema = SchemaFactory.createForClass(AiStudioSetting);
AiStudioSettingSchema.index({ weeklyDigestEnabled: 1, weeklyDigestLastWeek: 1 });
