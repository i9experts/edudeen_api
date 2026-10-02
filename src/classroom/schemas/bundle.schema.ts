/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BundleDocument = Bundle & Document;

export const BUNDLE_MIN_ITEMS = 2;
export const BUNDLE_MAX_ITEMS = 20;
export const BUNDLE_MIN_PERCENT = 5;
export const BUNDLE_MAX_PERCENT = 70;

/**
 * A seller's "buy these together and save" set — e.g. a full Grade 5 pack of
 * Maths + English + Science workbooks at 20% off. There's no separate bundle
 * SKU: the buyer adds the items to the cart and checkout takes the percentage
 * off once every item in the bundle is there (see CheckoutService's
 * automatic-discount pass, which treats an active bundle as one more candidate).
 */
@Schema({ timestamps: true })
export class Bundle {
  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, unique: true })
  slug: string;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: [String], required: true })
  productIds: string[];

  @Prop({ type: Number, required: true })
  discountPercent: number;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const BundleSchema = SchemaFactory.createForClass(Bundle);
BundleSchema.index({ productIds: 1, isActive: 1, isDelete: 1 });
