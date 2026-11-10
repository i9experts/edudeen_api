/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const CATEGORY_REQUEST_TYPES = ['subcategory', 'main_change'] as const;
export const CATEGORY_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** A seller's ask for a new subcategory (or a change of their main category). Own collection; never edits the tree. */
@Schema({ timestamps: true, collection: 'category_requests' })
export class CategoryRequest {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, enum: CATEGORY_REQUEST_TYPES, required: true }) type: string;
  /** Wanted subcategory name, or the wanted main category for `main_change`. */
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) reason: string;
  @Prop({ type: String, required: true }) exampleProduct: string;
  /** The store's main category when the request was made (context for the admin). */
  @Prop({ type: String, default: null }) mainCategoryId: string | null;
  @Prop({ type: String, enum: CATEGORY_REQUEST_STATUSES, default: 'pending' }) status: string;
  @Prop({ type: String, default: null }) adminNote: string | null;
  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
}
export type CategoryRequestDocument = CategoryRequest & Document;
export const CategoryRequestSchema = SchemaFactory.createForClass(CategoryRequest);
CategoryRequestSchema.index({ storeId: 1, status: 1, createdAt: -1 });
CategoryRequestSchema.index({ status: 1, createdAt: -1 });
