/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type QuickReplyDocument = QuickReply & Document;

export const QUICK_REPLY_CATEGORIES = ['download_help', 'order_status', 'refund_policy', 'course_access', 'general'] as const;
export type QuickReplyCategory = (typeof QUICK_REPLY_CATEGORIES)[number];

@Schema({ timestamps: true, collection: 'quick_replies' })
export class QuickReply {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true, maxlength: 60 }) title: string;
  @Prop({ type: String, required: true, maxlength: 1000 }) body: string;
  @Prop({ type: String, enum: QUICK_REPLY_CATEGORIES, default: 'general' }) category: QuickReplyCategory;
  @Prop({ type: Number, default: 0 }) sortOrder: number;
  @Prop({ type: Boolean, default: false }) isDefault: boolean;
}

export const QuickReplySchema = SchemaFactory.createForClass(QuickReply);
QuickReplySchema.index({ storeId: 1, sortOrder: 1 });
