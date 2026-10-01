/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { SeoMeta, SeoMetaSchema } from '../../seo/schemas/seo-meta.schema';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {

  @Prop({ required: true })
  name: string;

  // URL-safe handle for the public marketplace path (/marketplace/:slug).
  // Generated once at creation (see CategoriesService.addCategory) and never
  // regenerated — updateCategory renames the category but keeps the URL stable.
  @Prop({ type: String, unique: true, sparse: true })
  slug: string;

@Prop({ type: String, default: null })
parentId: string | null;

@Prop({ type: String, default: null })
image: string;

@Prop({ type: String, default: null })
description: string | null;


  @Prop({ default: 0 })
  sortOrder: number;


  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;

  // Who created this category — admin (main categories) or a seller
  // (optional subcategories). Lets a seller's own subcategories be told
  // apart from the admin-curated taxonomy.
  @Prop({ type: String, default: null })
  createdBy: string | null;

  @Prop({ type: String, enum: ['admin', 'seller'], default: null })
  createdByRole: string | null;

  // Admin-managed SEO override for this category's marketplace page. See
  // seo/schemas/seo-meta.schema.ts — root categories are admin-only anyway
  // (CategoriesService.addCategory), so this is edited exclusively via
  // admin/seo/categories/:id, never by sellers.
  @Prop({ type: SeoMetaSchema, default: () => ({}) })
  seo: SeoMeta;

}

export const CategorySchema = SchemaFactory.createForClass(Category);

// indexes
CategorySchema.index({ name: 1 });
CategorySchema.index({ parentId: 1 });
CategorySchema.index({ createdBy: 1 });
