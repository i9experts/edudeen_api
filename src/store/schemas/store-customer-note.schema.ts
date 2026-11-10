import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreCustomerNoteDocument = StoreCustomerNote & Document;

/** A seller's PRIVATE note + tags about one buyer of their store. Never returned by any buyer-facing endpoint. */
@Schema({ timestamps: true, collection: 'store_customer_notes' })
export class StoreCustomerNote {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  buyerId: string;

  @Prop({ default: '' })
  note: string;

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const StoreCustomerNoteSchema = SchemaFactory.createForClass(StoreCustomerNote);
StoreCustomerNoteSchema.index({ storeId: 1, buyerId: 1 }, { unique: true });
