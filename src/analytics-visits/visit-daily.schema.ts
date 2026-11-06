/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Daily visit counts, one row per (store, product|'', PKT day, source). No visitor data at all.
 * productId '' = visits to the STORE (one per anonymous session per 30 min, from any page of the store);
 * productId set = views of that product page.
 */
@Schema({ timestamps: false, collection: 'analytics_visit_daily' })
export class VisitDaily {
  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, default: '' }) productId: string;
  @Prop({ required: true }) pktDate: string; // YYYY-MM-DD, Asia/Karachi
  @Prop({ required: true }) source: string;
  @Prop({ type: Number, default: 0 }) visits: number;
}
export type VisitDailyDocument = VisitDaily & Document;
export const VisitDailySchema = SchemaFactory.createForClass(VisitDaily);
VisitDailySchema.index({ storeId: 1, pktDate: 1 });
VisitDailySchema.index({ storeId: 1, productId: 1, pktDate: 1, source: 1 }, { unique: true });

/** Words buyers searched on Edudeen right before opening this store (only for visits that came from Edudeen search). */
@Schema({ timestamps: false, collection: 'analytics_term_daily' })
export class TermDaily {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) pktDate: string;
  @Prop({ required: true }) term: string;
  @Prop({ type: Number, default: 0 }) visits: number;
}
export type TermDailyDocument = TermDaily & Document;
export const TermDailySchema = SchemaFactory.createForClass(TermDaily);
TermDailySchema.index({ storeId: 1, pktDate: 1 });
TermDailySchema.index({ storeId: 1, pktDate: 1, term: 1 }, { unique: true });
