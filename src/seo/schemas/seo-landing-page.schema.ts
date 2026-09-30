/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { SeoMeta, SeoMetaSchema } from './seo-meta.schema';

export type SeoLandingPageDocument = SeoLandingPage & Document;

@Schema({ timestamps: true })
export class SeoLandingPage {
  @Prop({ type: String, required: true, unique: true })
  slug: string; // served at /pages/:slug on the frontend

  @Prop({ type: String, required: true })
  title: string;

  // Opaque frontend-owned content blocks — same "backend enforces meta,
  // frontend owns layout" split already used for Store.builderConfig.
  @Prop({ type: Object, default: () => ({}) })
  content: Record<string, any>;

  @Prop({ type: String, enum: ['draft', 'published'], default: 'draft' })
  status: string;

  @Prop({ type: SeoMetaSchema, default: () => ({}) })
  seo: SeoMeta;

  @Prop({ type: String, default: null })
  createdByAdminId: string | null;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const SeoLandingPageSchema = SchemaFactory.createForClass(SeoLandingPage);
SeoLandingPageSchema.index({ status: 1 });
