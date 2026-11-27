/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const ACADEMY_CATEGORIES = [
  'getting_started', 'products_listings', 'orders_reviews', 'shipping', 'payments_finance', 'marketing', 'policies_guidelines',
] as const;
export type AcademyCategory = (typeof ACADEMY_CATEGORIES)[number];

export const ACADEMY_LESSON_TYPES = ['video', 'text', 'pdf'] as const;
export type AcademyLessonType = (typeof ACADEMY_LESSON_TYPES)[number];

@Schema({ _id: true })
export class AcademyLesson {
  @Prop({ required: true }) title: string;
  @Prop({ type: String, enum: ACADEMY_LESSON_TYPES, default: 'text' }) type: AcademyLessonType;
  @Prop({ type: String, default: null }) videoUrl: string | null;
  // Plain text with light markdown (## headings, - bullets). Rendered as text on the client, never as HTML.
  @Prop({ type: String, default: '' }) body: string;
  @Prop({ type: String, default: null }) fileUrl: string | null;
  @Prop({ type: Number, default: null }) durationMinutes: number | null;
}
export const AcademyLessonSchema = SchemaFactory.createForClass(AcademyLesson);

export type AcademyCourseDocument = AcademyCourse & Document;

// Edudeen Academy: training written by the platform team for sellers. Separate from `classroom`,
// which is sellers' own courses sold to buyers.
@Schema({ timestamps: true, collection: 'academy_courses' })
export class AcademyCourse {
  @Prop({ required: true }) title: string;
  @Prop({ required: true, unique: true }) slug: string;
  @Prop({ type: String, default: '' }) summary: string;
  @Prop({ type: String, default: null }) coverImage: string | null;
  @Prop({ type: String, enum: ACADEMY_CATEGORIES, default: 'getting_started' }) category: AcademyCategory;
  // ISO country codes. Empty = every country.
  @Prop({ type: [String], default: [] }) countries: string[];
  @Prop({ type: String, default: null }) language: string | null;
  @Prop({ type: String, enum: ['draft', 'published'], default: 'draft' }) status: 'draft' | 'published';
  @Prop({ type: Boolean, default: false }) isRecommended: boolean;
  @Prop({ type: Number, default: 0 }) order: number;
  @Prop({ type: [AcademyLessonSchema], default: [] }) lessons: AcademyLesson[];
  @Prop({ type: Number, default: 0 }) viewCount: number;
  @Prop({ type: Date, default: null }) publishedAt: Date | null;
  @Prop({ type: String, default: null }) createdBy: string | null;
}
export const AcademyCourseSchema = SchemaFactory.createForClass(AcademyCourse);
AcademyCourseSchema.index({ status: 1, countries: 1 });

export type AcademyProgressDocument = AcademyProgress & Document;

@Schema({ timestamps: true, collection: 'academy_progress' })
export class AcademyProgress {
  @Prop({ required: true }) sellerId: string;
  @Prop({ required: true }) courseId: string;
  @Prop({ type: [String], default: [] }) completedLessonIds: string[];
  @Prop({ type: Date, default: null }) completedAt: Date | null;
  @Prop({ type: Date, default: null }) lastViewedAt: Date | null;
}
export const AcademyProgressSchema = SchemaFactory.createForClass(AcademyProgress);
AcademyProgressSchema.index({ sellerId: 1, courseId: 1 }, { unique: true });
