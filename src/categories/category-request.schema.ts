/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const CATEGORY_REQUEST_TYPES = ['subcategory', 'main_change', 'extra_category'] as const;
export const CATEGORY_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** A seller's ask for a new subcategory, a change of their main category, or (once already at the
 *  MAX_STORE_CATEGORIES cap) an additional main category. Own collection; never edits the tree. */
@Schema({ timestamps: true, collection: 'category_requests' })
export class CategoryRequest {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, enum: CATEGORY_REQUEST_TYPES, required: true }) type: string;
  /** Wanted subcategory name, the wanted main category for `main_change`, or the real category's own
   *  name for `extra_category` (set server-side from `requestedCategoryId`, not typed by the seller). */
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) reason: string;
  @Prop({ type: String, required: true }) exampleProduct: string;
  /** The store's main category when the request was made (context for the admin). */
  @Prop({ type: String, default: null }) mainCategoryId: string | null;
  /** `extra_category` only: the real, already-existing main category being requested as an addition.
   *  Approving the request pushes it straight onto the store's `categoryIds`, past the normal cap. */
  @Prop({ type: String, default: null }) requestedCategoryId: string | null;
  @Prop({ type: String, enum: CATEGORY_REQUEST_STATUSES, default: 'pending' }) status: string;
  @Prop({ type: String, default: null }) adminNote: string | null;
  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
}
export type CategoryRequestDocument = CategoryRequest & Document;
export const CategoryRequestSchema = SchemaFactory.createForClass(CategoryRequest);
CategoryRequestSchema.index({ storeId: 1, status: 1, createdAt: -1 });
CategoryRequestSchema.index({ status: 1, createdAt: -1 });
