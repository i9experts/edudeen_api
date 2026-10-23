import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ActivityLogDocument = ActivityLog & Document;

export const ACTIVITY_LOG_CATEGORIES = [
  'products',
  'orders',
  'finance',
  'marketing',
  'customers',
  'settings',
  'security',
  'loyalty',
  'subscriptions',
  'platform_billing',
  'platform_plans',
  'seo',
  'ai_studio',
  'announcements',
  'moderation',
  'promotions',
] as const;

export type ActivityLogCategory = (typeof ACTIVITY_LOG_CATEGORIES)[number];

@Schema({ timestamps: true })
export class ActivityLog {
  // 'platform' sentinel = a platform-level action with no single store
  // (e.g. admin creating/editing a PlatformPlan) rather than a real store id.
  @Prop({ type: String, default: 'platform' })
  storeId: string;

  @Prop({ type: String, default: null })
  actorId: string | null;

  @Prop({ type: String, default: null })
  actorName: string | null;

  @Prop({ type: String, default: null })
  actorRole: string | null;

  @Prop({ required: true, enum: ACTIVITY_LOG_CATEGORIES })
  category: ActivityLogCategory;

  @Prop({ required: true })
  action: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  targetId: string | null;

  @Prop({ type: String, default: null })
  targetType: string | null;

  @Prop({ type: String, default: null })
  ip: string | null;

  @Prop({ type: String, default: null })
  userAgent: string | null;

  @Prop({ type: Boolean, default: false })
  isSecurityAlert: boolean;

  @Prop({ type: Object, default: null })
  metadata: object | null;
}

export const ActivityLogSchema = SchemaFactory.createForClass(ActivityLog);

ActivityLogSchema.index({ storeId: 1, createdAt: -1 });
ActivityLogSchema.index({ storeId: 1, category: 1 });
ActivityLogSchema.index({ storeId: 1, actorId: 1 });
ActivityLogSchema.index({ storeId: 1, isSecurityAlert: 1 });
// Platform-wide audit queries (admin activity log filters by category/action, newest first).
ActivityLogSchema.index({ category: 1, action: 1, createdAt: -1 });
