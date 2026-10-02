/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CuratedCollectionDocument = CuratedCollection & Document;

/**
 * An Edudeen-picked, marketplace-wide shelf — "Exam ki tayyari", "Ramzan for
 * kids", "Back to school: Grade 1". Unlike a store's own Collection it spans
 * every store. Hand-picked products come first, then (optionally) the best
 * sellers that match a simple rule, so a seasonal shelf never looks empty.
 */
@Schema({ timestamps: true })
export class CuratedCollection {
  @Prop({ type: String, required: true, trim: true })
  title: string;

  @Prop({ type: String, required: true, unique: true })
  slug: string;

  @Prop({ type: String, default: '' })
  subtitle: string;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: [String], default: [] })
  productIds: string[];

  @Prop({
    type: {
      educationLevel: { type: String, default: null },
      curriculum: { type: String, default: null },
      categoryId: { type: String, default: null },
      tags: { type: [String], default: [] },
    },
    default: () => ({ educationLevel: null, curriculum: null, categoryId: null, tags: [] }),
  })
  rule: { educationLevel: string | null; curriculum: string | null; categoryId: string | null; tags: string[] };

  @Prop({ type: String, enum: ['active', 'draft'], default: 'draft' })
  status: 'active' | 'draft';

  @Prop({ type: Boolean, default: true })
  showOnHome: boolean;

  @Prop({ type: Number, default: 0 })
  order: number;

  // Optional season — outside it the shelf is hidden without being deleted.
  @Prop({ type: Date, default: null })
  startsAt: Date | null;

  @Prop({ type: Date, default: null })
  endsAt: Date | null;
}

export const CuratedCollectionSchema = SchemaFactory.createForClass(CuratedCollection);
CuratedCollectionSchema.index({ status: 1, showOnHome: 1, order: 1 });
