/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RecentlyViewedDocument = RecentlyViewed & Document;

/** One product a buyer has opened — upserted per (user, product), so
 *  re-opening a product bumps it to the top of the recently-viewed strip. */
@Schema({ timestamps: true })
export class RecentlyViewed {
  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  productId!: string;

  @Prop({ type: Number, default: 1 })
  viewCount!: number;
}

export const RecentlyViewedSchema = SchemaFactory.createForClass(RecentlyViewed);
RecentlyViewedSchema.index({ userId: 1, productId: 1 }, { unique: true });
RecentlyViewedSchema.index({ userId: 1, updatedAt: -1 });
// "Students also viewed" rail: find the recent viewers of one product.
RecentlyViewedSchema.index({ productId: 1, updatedAt: -1 });
