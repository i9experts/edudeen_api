/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LearningPathDocument = LearningPath & Document;

@Schema({ _id: true })
export class LearningPathStep {
  /** e.g. "Maths", "Urdu reading", "Islamiyat" */
  @Prop({ type: String, required: true, trim: true })
  title: string;

  /** short guidance for the parent: "Start here - 15 minutes a day" */
  @Prop({ type: String, default: '' })
  note: string;

  /** the admin's picks for this step, in order */
  @Prop({ type: [String], default: [] })
  productIds: string[];
}
export const LearningPathStepSchema = SchemaFactory.createForClass(LearningPathStep);

/**
 * An admin-curated, ordered learning path for one grade/age ("Class 3 - first term"): a list of subject steps, each with
 * hand-picked resources. Parents can save a whole path as their own reading list. Nothing is seeded; admins create them.
 */
@Schema({ timestamps: true })
export class LearningPath {
  @Prop({ type: String, required: true, trim: true })
  title: string;

  @Prop({ type: String, required: true, unique: true })
  slug: string;

  /** one of EDUCATION_LEVELS values (primary_school ...), or null for "any grade" */
  @Prop({ type: String, default: null, index: true })
  educationLevel: string | null;

  /** free text such as "Ages 8-9" */
  @Prop({ type: String, default: '' })
  ageLabel: string;

  @Prop({ type: String, default: '' })
  subtitle: string;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: [LearningPathStepSchema], default: [] })
  steps: LearningPathStep[];

  @Prop({ type: String, enum: ['active', 'draft'], default: 'draft' })
  status: 'active' | 'draft';

  @Prop({ type: Number, default: 0 })
  order: number;
}

export const LearningPathSchema = SchemaFactory.createForClass(LearningPath);
LearningPathSchema.index({ status: 1, educationLevel: 1, order: 1 });
