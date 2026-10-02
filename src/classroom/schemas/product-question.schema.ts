/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductQuestionDocument = ProductQuestion & Document;

/**
 * A buyer's pre-purchase question on a listing ("Is this aligned to the
 * Punjab board?") and the seller's public answer. Only answered, visible
 * questions show on the product page; the asker also sees their own pending ones.
 */
@Schema({ timestamps: true })
export class ProductQuestion {
  @Prop({ type: String, required: true, index: true })
  productId: string;

  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true, index: true })
  askerId: string;

  @Prop({ type: String, default: '' })
  askerName: string;

  @Prop({ type: String, required: true })
  question: string;

  @Prop({ type: String, default: null })
  answer: string | null;

  @Prop({ type: Date, default: null })
  answeredAt: Date | null;

  @Prop({ type: Boolean, default: false })
  hidden: boolean;
}

export const ProductQuestionSchema = SchemaFactory.createForClass(ProductQuestion);
ProductQuestionSchema.index({ productId: 1, answeredAt: -1 });
ProductQuestionSchema.index({ storeId: 1, answeredAt: 1, createdAt: -1 });
