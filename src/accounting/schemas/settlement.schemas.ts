/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// ── Stripe balance transactions (platform account), mirrored read-only ──────────
/**
 * One row per Stripe balance transaction (`txn_…`) of the PLATFORM account, copied by the settlement sync. The
 * row records how the posting rules classified it and which journal (if any) it produced, so the reconciliation
 * screen can list what was posted, skipped (already in the books via another source) or left for review.
 */
@Schema({ timestamps: true, collection: 'acct_stripe_btx' })
export class StripeBalanceTxn {
  @Prop({ type: String, required: true, unique: true }) btxId: string;
  @Prop({ type: String, required: true }) type: string;
  @Prop({ type: String, default: null }) reportingCategory: string | null;
  /** Major units in `currency` (the Stripe balance currency), signed like Stripe: + into the balance, - out. */
  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: Number, default: 0 }) fee: number;
  @Prop({ type: Number, default: 0 }) net: number;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Date, required: true }) created: Date;
  @Prop({ type: Date, default: null }) availableOn: Date | null;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: String, default: null }) sourceId: string | null;
  @Prop({ type: String, default: null }) chargeId: string | null;
  @Prop({ type: String, default: null }) paymentIntentId: string | null;
  /** What the money was for: marketplace, plan_invoice, addon, connect, promotion, gift_card, unmatched, payout, fee, other. */
  @Prop({ type: String, default: null }) classification: string | null;
  @Prop({ type: String, default: null }) connectDestination: string | null;
  /** Destination charges: the gross charge and the platform's application fee (major units). */
  @Prop({ type: Number, default: null }) chargeAmount: number | null;
  @Prop({ type: Number, default: null }) applicationFee: number | null;
  @Prop({ type: String, enum: ['posted', 'skipped', 'error', 'pending'], default: 'pending' }) status: 'posted' | 'skipped' | 'error' | 'pending';
  @Prop({ type: String, default: null }) reason: string | null;
  @Prop({ type: String, default: null }) journalId: string | null;
  @Prop({ type: Number, default: 0 }) attempts: number;
}
export const StripeBalanceTxnSchema = SchemaFactory.createForClass(StripeBalanceTxn);
StripeBalanceTxnSchema.index({ created: -1 });
StripeBalanceTxnSchema.index({ status: 1, created: -1 });
StripeBalanceTxnSchema.index({ chargeId: 1 });

// ── COD remittances (courier statements) ─────────────────────────────────────────
export const COD_COURIERS = ['tcs', 'leopards', 'postex', 'other'] as const;
export type CodCourier = (typeof COD_COURIERS)[number];
export const COD_LINE_STATUSES = ['matched', 'short', 'over', 'unknown', 'duplicate'] as const;
export type CodLineStatus = (typeof COD_LINE_STATUSES)[number];

@Schema({ _id: false })
export class CodRemittanceLine {
  @Prop({ type: String, required: true }) trackingNumber: string;
  @Prop({ type: String, default: null }) orderId: string | null;
  @Prop({ type: String, default: null }) orderNumber: string | null;
  @Prop({ type: String, default: null }) sellerOrderId: string | null;
  @Prop({ type: String, default: null }) storeId: string | null;
  @Prop({ type: String, default: null }) customerId: string | null;
  @Prop({ type: String, default: null }) customerName: string | null;
  /** What the rider should have collected (booked COD amount, in PKR). null when the parcel is not ours. */
  @Prop({ type: Number, default: null }) codExpected: number | null;
  @Prop({ type: Number, default: 0 }) codCollected: number;
  /** Courier deductions on this parcel (delivery / COD fee), PKR. */
  @Prop({ type: Number, default: 0 }) charges: number;
  @Prop({ type: String, enum: COD_LINE_STATUSES, default: 'unknown' }) status: CodLineStatus;
  @Prop({ type: String, default: null }) note: string | null;
  /** Another approved remittance already holds this parcel. */
  @Prop({ type: String, default: null }) duplicateOf: string | null;
}
export const CodRemittanceLineSchema = SchemaFactory.createForClass(CodRemittanceLine);

/**
 * A courier's cash-on-delivery statement: the parcels it collected for Edudeen, what it deducted, and what reached
 * the bank. Prepared (imported/edited) by finance, approved by someone else; approval posts one journal that clears
 * COD receivable from couriers (1110) and claims every matched parcel in `acct_cod_items` so it can't be remitted twice.
 */
@Schema({ timestamps: true, collection: 'acct_cod_remittances' })
export class CodRemittance {
  @Prop({ type: String, enum: COD_COURIERS, required: true }) courier: CodCourier;
  @Prop({ type: String, default: null }) statementRef: string | null;
  @Prop({ type: Date, required: true }) remittanceDate: Date;
  /** COA code of the bank / cash account the net was paid into. */
  @Prop({ type: String, required: true }) bankAccount: string;
  @Prop({ type: [CodRemittanceLineSchema], default: [] }) lines: CodRemittanceLine[];
  /** Header totals (PKR). gross/charges are the sums of the lines; otherDeductions and netReceived are entered. */
  @Prop({ type: Number, default: 0 }) grossCollected: number;
  @Prop({ type: Number, default: 0 }) courierCharges: number;
  @Prop({ type: Number, default: 0 }) otherDeductions: number;
  /** COA code the other deductions are booked to (default Miscellaneous expenses 6900). */
  @Prop({ type: String, default: '6900' }) otherDeductionsAccount: string;
  @Prop({ type: Number, default: 0 }) netReceived: number;
  @Prop({ type: String, default: null }) notes: string | null;
  @Prop({ type: String, default: null }) fileName: string | null;
  /** Column names used for the uploaded statement (kept so the next upload from this courier can reuse them). */
  @Prop({ type: Object, default: null }) mapping: { tracking: string; cod: string; charges?: string | null } | null;
  @Prop({ type: String, enum: ['draft', 'submitted', 'approved', 'void'], default: 'draft' }) status: 'draft' | 'submitted' | 'approved' | 'void';
  @Prop({ type: String, default: null }) preparedBy: string | null;
  @Prop({ type: String, default: null }) submittedBy: string | null;
  @Prop({ type: Date, default: null }) submittedAt: Date | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: String, default: null }) rejectReason: string | null;
  @Prop({ type: [String], default: [] }) journalIds: string[];
}
export const CodRemittanceSchema = SchemaFactory.createForClass(CodRemittance);
CodRemittanceSchema.index({ status: 1, remittanceDate: -1 });
CodRemittanceSchema.index({ 'lines.trackingNumber': 1 });

/** Claims a parcel for exactly one approved remittance (unique on the normalised tracking number). */
@Schema({ timestamps: true, collection: 'acct_cod_items' })
export class CodRemittanceItem {
  @Prop({ type: String, required: true, unique: true }) trackingNumber: string;
  @Prop({ type: String, required: true }) remittanceId: string;
  @Prop({ type: String, default: null }) orderId: string | null;
  @Prop({ type: String, default: null }) sellerOrderId: string | null;
  @Prop({ type: String, required: true }) courier: string;
  @Prop({ type: Number, default: 0 }) codCollected: number;
  @Prop({ type: Date, required: true }) remittanceDate: Date;
}
export const CodRemittanceItemSchema = SchemaFactory.createForClass(CodRemittanceItem);
CodRemittanceItemSchema.index({ sellerOrderId: 1 });
