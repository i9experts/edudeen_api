/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CourseDocument = Course & Document;
export type CourseProgressDocument = CourseProgress & Document;

export const LESSON_TYPES = ['video', 'pdf', 'text', 'quiz'] as const;
export type LessonType = (typeof LESSON_TYPES)[number];
export const COURSE_LIMITS = { sections: 30, lessonsPerSection: 50, quizQuestions: 30, options: 6 } as const;

/**
 * The content of a "course" product: sections of lessons (video, PDF, text or
 * a quiz). Files are private uploads streamed to buyers through short signed
 * links. One course per product.
 */
@Schema({ timestamps: true })
export class Course {
  @Prop({ type: String, required: true, unique: true })
  productId: string;

  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  // Stored as plain objects — see cleanCourseInput for the exact shape.
  @Prop({ type: [Object], default: [] })
  sections: {
    _id: string;
    title: string;
    lessons: {
      _id: string;
      title: string;
      type: LessonType;
      file: { url: string; name: string; size: number | null; mimeType: string | null } | null;
      text: string;
      durationMinutes: number | null;
      isPreview: boolean;
      quiz: { passPercent: number; questions: { question: string; options: string[]; answerIndex: number }[] } | null;
    }[];
  }[];

  @Prop({ type: Boolean, default: true })
  certificateEnabled: boolean;
}
export const CourseSchema = SchemaFactory.createForClass(Course);

/** One learner's progress through one course, and their certificate once finished. */
@Schema({ timestamps: true })
export class CourseProgress {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: [String], default: [] })
  completedLessonIds: string[];

  @Prop({ type: Object, default: {} })
  quizScores: Record<string, number>;

  @Prop({ type: String, default: null })
  lastLessonId: string | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: String, default: null })
  certificateCode: string | null;

  @Prop({ type: String, default: '' })
  learnerName: string;
}
export const CourseProgressSchema = SchemaFactory.createForClass(CourseProgress);
CourseProgressSchema.index({ userId: 1, productId: 1 }, { unique: true });
CourseProgressSchema.index({ certificateCode: 1 }, { unique: true, partialFilterExpression: { certificateCode: { $type: 'string' } } });
