import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PlatformTestimonialDocument = HydratedDocument<PlatformTestimonial>;

// A seller's review of the Edudeen platform itself (not a buyer's review of a
// store/product — that's the separate `Rating` collection, seller-managed on
// their own storefront). Admin-curated only, like a Shopify/BigCommerce
// "customer stories" section — no self-serve seller submission form exists.
@Schema({ timestamps: true })
export class PlatformTestimonial {
  _id: string;

  @Prop({ required: true, trim: true })
  sellerName: string;

  @Prop({ type: String, trim: true, default: null })
  storeName: string | null;

  @Prop({ required: true, min: 1, max: 5 })
  rating: number;

  @Prop({ required: true, trim: true })
  text: string;

  @Prop({ default: true })
  isVerifiedSeller: boolean;

  @Prop({ default: 0, min: 0 })
  order: number;

  @Prop({ default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PlatformTestimonialSchema = SchemaFactory.createForClass(PlatformTestimonial);

PlatformTestimonialSchema.index({ isActive: 1 });
PlatformTestimonialSchema.index({ order: 1 });

PlatformTestimonialSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
