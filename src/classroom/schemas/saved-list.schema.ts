/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SavedListDocument = SavedList & Document;

@Schema({ _id: false })
export class SavedListItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, default: '' })
  note: string;

  @Prop({ type: Date, default: () => new Date() })
  addedAt: Date;
}
const SavedListItemSchema = SchemaFactory.createForClass(SavedListItem);

/**
 * A teacher's named list of resources ("Grade 5 Term 1", "Eid activities") —
 * many per buyer, optionally public so it can be shared with parents or
 * colleagues through `/lists/:slug`. Unlike the per-store wishlist these lists
 * span every store on the marketplace.
 */
@Schema({ timestamps: true })
export class SavedList {
  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: String, required: true, unique: true })
  slug: string;

  @Prop({ type: Boolean, default: false })
  isPublic: boolean;

  @Prop({ type: [SavedListItemSchema], default: [] })
  items: SavedListItem[];
}

export const SavedListSchema = SchemaFactory.createForClass(SavedList);
SavedListSchema.index({ userId: 1, updatedAt: -1 });
