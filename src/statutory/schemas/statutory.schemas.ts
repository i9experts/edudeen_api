import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  AUTHORITIES,
  PAYMENT_STATUSES,
  STATEMENT_STATUSES,
  type Authority,
  type PaymentStatus,
  type StatementStatus,
  type StatementLine,
} from '../statutory.util';

@Schema({ _id: true, timestamps: false })
export class StatutoryPaymentRecord {
  _id: Types.ObjectId;
  /** FBR Payment Slip ID (blank for EOBI challans). */
  @Prop({ type: String, default: null }) psid: string | null;
  /** CPR number (FBR) or challan number (EOBI / PF). */
  @Prop({ type: String, required: true }) cprNumber: string;
  @Prop({ type: Date, required: true }) paymentDate: Date;
  /** COA bank / cash account the money left from. */
  @Prop({ type: String, required: true }) bankAccount: string;
  @Prop({ type: Number, required: true }) amount: number;
  /** Late-payment penalty / default surcharge paid with it (posted to Penalties & fines). */
  @Prop({ type: Number, default: 0 }) penalty: number;
  @Prop({ type: Object, default: null }) receipt: {
    publicId: string;
    resourceType: string;
    fileName: string;
    mimeType: string;
  } | null;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, enum: PAYMENT_STATUSES, default: 'submitted' })
  status: PaymentStatus;
  @Prop({ type: String, required: true }) preparedBy: string;
  @Prop({ type: Date, default: () => new Date() }) submittedAt: Date;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: String, default: null }) rejectReason: string | null;
  @Prop({ type: String, default: null }) journalId: string | null;
}
export const StatutoryPaymentRecordSchema = SchemaFactory.createForClass(
  StatutoryPaymentRecord,
);

/**
 * What Edudeen owes one authority for one month (FBR salary tax, contractor withholding, EOBI, PF, or a manual
 * FBR item) and the payments made against it. Generated from approved payroll runs (one per run + authority) or
 * created by hand.
 */
@Schema({ timestamps: true, collection: 'statutory_payments' })
export class StatutoryPayment {
  @Prop({ type: String, enum: AUTHORITIES, required: true })
  authority: Authority;
  /** Liability account the money sits in until paid (2220 / 2210 / 2230 / 2240, or a chosen tax liability). */
  @Prop({ type: String, required: true }) liabilityAccount: string;
  @Prop({ type: String, required: true }) month: string;
  @Prop({ type: String, required: true }) taxYear: string;
  @Prop({ type: Date, required: true }) dueDate: Date;
  @Prop({ type: String, enum: ['payroll_run', 'manual'], required: true })
  origin: 'payroll_run' | 'manual';
  /** Payroll run it came from (unique per run + authority). */
  @Prop({ type: String, default: null }) runId: string | null;
  @Prop({ type: String, default: null }) title: string | null;
  @Prop({ type: [Object], default: [] }) lines: StatementLine[];
  /** Total owed = sum of lines. */
  @Prop({ type: Number, required: true }) amount: number;
  /** What the run's accrual journal credited to the liability account (payroll statements); null for manual ones. */
  @Prop({ type: Number, default: null }) ledgerAccrued: number | null;
  @Prop({ type: String, default: null }) accrualJournalId: string | null;
  @Prop({
    type: String,
    enum: STATEMENT_STATUSES,
    default: 'pending',
    index: true,
  })
  status: StatementStatus;
  @Prop({ type: [StatutoryPaymentRecordSchema], default: [] })
  payments: StatutoryPaymentRecord[];
  /** Reminder e-mails already sent (each kind once). */
  @Prop({
    type: Object,
    default: () => ({ dueSoonSentAt: null, overdueSentAt: null }),
  })
  reminders: { dueSoonSentAt: Date | null; overdueSentAt: Date | null };
  @Prop({ type: String, default: null }) createdBy: string | null;
  @Prop({ type: String, default: null }) notes: string | null;
  @Prop({ type: [Object], default: [] }) history: {
    at: Date;
    by: string;
    action: string;
    note?: string | null;
  }[];
}
export type StatutoryPaymentDocument = HydratedDocument<StatutoryPayment>;
export const StatutoryPaymentSchema =
  SchemaFactory.createForClass(StatutoryPayment);
// One statement per payroll run and authority: the generator can run any number of times.
StatutoryPaymentSchema.index(
  { runId: 1, authority: 1 },
  { unique: true, partialFilterExpression: { runId: { $type: 'string' } } },
);
StatutoryPaymentSchema.index({ status: 1, dueDate: 1 });
StatutoryPaymentSchema.index({ authority: 1, month: -1 });
