import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StockHistoryDocument = HydratedDocument<StockHistory>;

/** One row per stock change made by the seller on the stock endpoints (order / return changes are not logged here). */
@Schema({ collection: 'stock_history', timestamps: { createdAt: true, updatedAt: false } })
export class StockHistory {
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: Number, required: true }) old: number;
  @Prop({ type: Number, required: true }) new: number;
  @Prop({ type: String, enum: ['manual', 'bulk'], required: true }) source: 'manual' | 'bulk';
  @Prop({ type: String, required: true }) actorId: string;
  createdAt: Date;
}

export const StockHistorySchema = SchemaFactory.createForClass(StockHistory);
StockHistorySchema.index({ storeId: 1, productId: 1, createdAt: -1 });
