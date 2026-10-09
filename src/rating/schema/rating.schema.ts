import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RatingDocument = Rating & Document;

@Schema({ _id: false })
class ReviewComment {
  @Prop({ required: true })
  text!: string;

  @Prop({ default: () => new Date() })
  createdAt!: Date;
}
const ReviewCommentSchema = SchemaFactory.createForClass(ReviewComment);

@Schema({ _id: false })
class SellerReply {
  @Prop({ required: true })
  text!: string;

  @Prop({ default: () => new Date() })
  createdAt!: Date;

  @Prop({ default: () => new Date() })
  updatedAt!: Date;
}
const SellerReplySchema = SchemaFactory.createForClass(SellerReply);

@Schema({ timestamps: true })
export class Rating {
  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  productId!: string;

  @Prop({ type: String, default: null })
  storeId!: string | null;

  @Prop({ type: String, default: null })
  productVariantId!: string | null;

  @Prop({ type: String, default: null })
  orderId!: string | null;

  @Prop({ type: Number, min: 1, max: 5, default: null })
  rating!: number | null;

  @Prop({ type: [ReviewCommentSchema], default: [] })
  comments!: ReviewComment[];

  @Prop({ type: [String], default: [] })
  media!: string[];

  @Prop({ default: false })
  isAnonymous!: boolean;

  @Prop({ type: SellerReplySchema, default: null })
  sellerReply!: SellerReply | null;

  @Prop({ default: false })
  isFlagged!: boolean;

  @Prop({ default: false })
  isVerifiedPurchase!: boolean;

  // Buyers who marked this review "helpful" — count is derived, not stored,
  // so it's always consistent with the array (no separate counter to drift).
  @Prop({ type: [String], default: [] })
  helpfulUserIds!: string[];

  @Prop({ default: false })
  isDelete!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RatingSchema = SchemaFactory.createForClass(Rating);

RatingSchema.index({ productId: 1 });
RatingSchema.index({ userId: 1 });
RatingSchema.index({ storeId: 1 });
RatingSchema.index({ userId: 1, productId: 1 });
// perf: compound indexes for hot query paths (additive)
RatingSchema.index({ productId: 1, createdAt: -1 });
RatingSchema.index({ storeId: 1, createdAt: -1 });
