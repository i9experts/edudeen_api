import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const SUPPORTED_CURRENCIES = ['PKR', 'USD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// Embedded on Checkout/Order/PaymentTransaction — one entry per currency
// actually involved in that transaction (checkout currency + every distinct
// seller currency present). Copied verbatim from Checkout down to Order/
// PaymentTransaction at creation time and never recomputed afterwards —
// refunds and settlement replay these exact values, never today's rate.
@Schema({ _id: false })
export class FxSnapshot {
  @Prop({ type: String, required: true })
  currency: string;

  // Units of `currency` per 1 USD (USD is the fixed pivot — see
  // ExchangeRateService). USD's own entry is always ratePerUSD: 1.
  @Prop({ type: Number, required: true })
  ratePerUSD: number;

  @Prop({ type: Date, required: true })
  effectiveFrom: Date;

  @Prop({ type: String, enum: ['provider', 'admin'], required: true })
  source: 'provider' | 'admin';

  // Points at the exact ExchangeRate row used, for audit/incident-response
  // ("which orders used rate X").
  @Prop({ type: String, default: null })
  exchangeRateId: string | null;
}

export const FxSnapshotSchema = SchemaFactory.createForClass(FxSnapshot);

export type ExchangeRateDocument = HydratedDocument<ExchangeRate>;

// Append-only history — the single authoritative source for every PKR/USD
// (and later EUR/GBP/...) conversion in the marketplace. "Current rate" for
// a currency is always the row with the latest effectiveFrom. Never mutate
// an existing row; a correction is a new row.
@Schema({ timestamps: true })
export class ExchangeRate {
  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: Number, required: true })
  ratePerUSD: number;

  @Prop({ type: Date, required: true })
  effectiveFrom: Date;

  @Prop({ type: String, enum: ['provider', 'admin'], required: true })
  source: 'provider' | 'admin';

  @Prop({ type: String, default: null })
  createdBy: string | null;

  // Set true for a row that failed the sanity-band/abnormal-jump check and
  // was intentionally NOT promoted to "current" — kept for audit visibility
  // rather than silently dropped.
  @Prop({ type: Boolean, default: false })
  isRejected: boolean;

  // Which check actually rejected/held this row — lets the admin FX UI show
  // a distinct "Sanity Band" vs "Abnormal Jump" badge instead of folding
  // both into one undifferentiated "Held" state. null for a normal
  // (non-rejected) row.
  @Prop({ type: String, enum: ['sanity_band', 'abnormal_jump', null], default: null })
  rejectionReason: 'sanity_band' | 'abnormal_jump' | null;

  // A held ('abnormal_jump') row waits for an admin decision: null = still waiting, 'confirmed' = an admin applied it
  // (as a NEW current row), 'dismissed' = an admin refused it. The held row itself is never promoted in place.
  @Prop({ type: String, enum: ['confirmed', 'dismissed', null], default: null })
  heldResolution: 'confirmed' | 'dismissed' | null;

  @Prop({ type: String, default: null })
  heldResolvedBy: string | null;

  @Prop({ type: Date, default: null })
  heldResolvedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ExchangeRateSchema = SchemaFactory.createForClass(ExchangeRate);

ExchangeRateSchema.index({ currency: 1, effectiveFrom: -1 });
ExchangeRateSchema.index({ currency: 1, isRejected: 1, effectiveFrom: -1 });
