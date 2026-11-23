/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReportDocument = Report & Document;

@Schema({ timestamps: true })
export class Report {
  @Prop({ type: String, required: true }) reporterId: string;
  @Prop({ type: String, required: true }) reporterRole: string;

  // 'listing' | 'seller' | 'review' added for admin Content Moderation
  // (marketplace-wide flags), on top of the original messaging-abuse types.
  // 'storePage' | 'blogPost' are RESERVED for future storefront-content
  // moderation (sections/blocks builder, blog) — deliberately NOT wired into
  // AdminModerationService's MARKETPLACE_TARGET_TYPES/enrich()/remove() yet;
  // half-wiring a moderation queue that doesn't actually act on these types
  // would be worse than not having one. Add that wiring as its own change
  // when there's a real product decision to moderate storefront content.
  @Prop({ type: String, enum: ['user', 'message', 'conversation', 'listing', 'seller', 'review', 'storePage', 'blogPost'], required: true }) targetType: string;
  @Prop({ type: String, required: true }) targetId: string;

  @Prop({ type: String, required: true }) reason: string;
  @Prop({ type: String, default: null }) details: string | null;

  @Prop({ type: String, enum: ['pending', 'reviewed', 'resolved'], default: 'pending' }) status: string;
  @Prop({ type: String, default: null }) adminNotes: string | null;

  // Content Moderation additions
  @Prop({ type: String, enum: ['high', 'medium', 'low'], default: 'low' }) riskLevel: string;
  @Prop({ type: String, enum: ['approved', 'removed'], default: null }) resolution: string | null;
  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: Date, default: null }) resolvedAt: Date | null;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

ReportSchema.index({ reporterId: 1 });
ReportSchema.index({ targetId: 1 });
ReportSchema.index({ status: 1, createdAt: -1 });
// One buyer report per review (POST /api/rating/:reviewId/report-by-buyer). Partial: other report kinds are unaffected.
ReportSchema.index(
  { reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { reporterRole: 'user', targetType: 'review' }, name: 'one_buyer_report_per_review' },
);
