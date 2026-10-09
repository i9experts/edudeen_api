/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type QuoteRequestDocument = QuoteRequest & Document;

export const INSTITUTION_TYPES = ['school', 'madrasa', 'academy', 'college', 'university', 'ngo', 'other'] as const;
export const QUOTE_STATUSES = ['pending', 'quoted', 'accepted', 'declined', 'cancelled'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

@Schema({ _id: false })
export class QuoteOffer {
  @Prop({ type: Number, required: true })
  unitPrice: number;

  @Prop({ type: Number, required: true })
  totalPrice: number;

  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: Date, default: null })
  validUntil: Date | null;

  @Prop({ type: String, default: '' })
  note: string;

  // Payment terms the seller offers (see quote-terms.util.ts). 'none' = pay on acceptance.
  @Prop({ type: String, enum: ['none', 'net_15', 'net_30', 'net_45'], default: 'none' })
  netTerms: string;
}
const QuoteOfferSchema = SchemaFactory.createForClass(QuoteOffer);

/**
 * A bulk-price request from a school or institute for one listing — the
 * Alibaba-style "request a quote" flow. The seller answers with a price; an
 * accepted quote doubles as a printable quotation the institute can file.
 */
@Schema({ timestamps: true })
export class QuoteRequest {
  @Prop({ type: String, required: true, unique: true })
  number: string;

  @Prop({ type: String, required: true, index: true })
  buyerId: string;

  @Prop({ type: String, default: '' })
  buyerEmail: string;

  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  productName: string;

  @Prop({ type: String, required: true })
  institutionName: string;

  @Prop({ type: String, enum: INSTITUTION_TYPES, default: 'school' })
  institutionType: string;

  @Prop({ type: String, default: '' })
  city: string;

  @Prop({ type: String, required: true })
  contactName: string;

  @Prop({ type: String, required: true })
  contactPhone: string;

  @Prop({ type: Number, required: true })
  quantity: number;

  @Prop({ type: String, default: '' })
  message: string;

  @Prop({ type: String, enum: QUOTE_STATUSES, default: 'pending', index: true })
  status: QuoteStatus;

  @Prop({ type: QuoteOfferSchema, default: null })
  offer: QuoteOffer | null;

  @Prop({ type: String, default: '' })
  declineReason: string;

  // Institution's purchase order (number and/or an uploaded file link), added by the buyer.
  @Prop({ type: String, default: '' })
  purchaseOrderNumber: string;

  @Prop({ type: String, default: null })
  purchaseOrderUrl: string | null;

  @Prop({ type: Date, default: null })
  quotedAt: Date | null;

  @Prop({ type: Date, default: null })
  respondedAt: Date | null;
}

export const QuoteRequestSchema = SchemaFactory.createForClass(QuoteRequest);
QuoteRequestSchema.index({ storeId: 1, status: 1, createdAt: -1 });
QuoteRequestSchema.index({ buyerId: 1, createdAt: -1 });
