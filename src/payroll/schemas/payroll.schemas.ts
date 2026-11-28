/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  ADVANCE_STATUSES, CLAIM_STATUSES, CLAIM_TYPES, RUN_STATUSES, WORKER_TYPES,
  type AdvanceStatus, type ClaimStatus, type ClaimType, type RunStatus, type WorkerType,
} from '../payroll.constants';
import type { Allowance, BonusTier, ClaimRate, IncentiveRule } from '../payroll.util';

// ── Compensation profile (one per team member, versioned) ─────────────────────
@Schema({ _id: false })
export class PayVersionDoc {
  /** 'YYYY-MM': the first payroll month this version applies to. Past months keep using older versions. */
  @Prop({ type: String, required: true }) effectiveFrom: string;
  @Prop({ type: String, enum: WORKER_TYPES, default: 'employee' }) workerType: WorkerType;
  @Prop({ type: Number, default: 0 }) baseMonthlySalary: number;
  @Prop({ type: Number, default: 0 }) monthlyRetainer: number;
  @Prop({ type: [Object], default: [] }) allowances: Allowance[];
  @Prop({ type: [Object], default: [] }) incentiveRules: IncentiveRule[];
  @Prop({ type: [Object], default: [] }) bonusTiers: BonusTier[];
  /** Per-claim-type rate (e.g. visit = PKR 500 per visit). Claims of that type are quantity x rate. */
  @Prop({ type: [Object], default: [] }) claimRates: ClaimRate[];
  @Prop({ type: Boolean, default: true }) eobiEnabled: boolean;
  @Prop({ type: Boolean, default: false }) pfEnabled: boolean;
  @Prop({ type: Number, default: 0 }) pfEmployeePct: number;
  @Prop({ type: Number, default: 0 }) pfEmployerPct: number;
  @Prop({ type: Number, default: 0 }) withholdingPct: number;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) createdBy: string | null;
  @Prop({ type: Date, default: () => new Date() }) createdAt: Date;
}
export const PayVersionSchema = SchemaFactory.createForClass(PayVersionDoc);

@Schema({ timestamps: true, collection: 'payroll_profiles' })
export class CompensationProfile {
  @Prop({ type: String, required: true, unique: true }) adminId: string;
  @Prop({ type: Boolean, default: true }) active: boolean;
  @Prop({ type: Date, default: null }) joiningDate: Date | null;
  @Prop({ type: Date, default: null }) exitDate: Date | null;
  /** Approves this person's claims. */
  @Prop({ type: String, default: null, index: true }) managerId: string | null;
  @Prop({ type: String, default: null }) designation: string | null;
  // Identity and bank details: AES-256-GCM (same key chain as payout account numbers). Never selected by default.
  @Prop({ type: String, default: null, select: false }) cnicEnc: string | null;
  @Prop({ type: String, default: null, select: false }) ntnEnc: string | null;
  @Prop({ type: String, default: null, select: false }) bankAccountEnc: string | null;
  @Prop({ type: String, default: null }) cnicLast4: string | null;
  @Prop({ type: String, default: null }) ntnLast4: string | null;
  @Prop({ type: String, default: null }) bankAccountLast4: string | null;
  /** EOBI registration number (for the monthly contribution list). Not secret. */
  @Prop({ type: String, default: null }) eobiNumber: string | null;
  @Prop({ type: String, default: null }) bankName: string | null;
  @Prop({ type: String, default: null }) accountTitle: string | null;
  @Prop({ type: [PayVersionSchema], default: [] }) versions: PayVersionDoc[];
  /** Every change (who, when, what fields) — compensation is audited. */
  @Prop({ type: [Object], default: [] }) history: { at: Date; by: string; action: string; fields: string[]; note?: string | null }[];
}
export type CompensationProfileDocument = HydratedDocument<CompensationProfile>;
export const CompensationProfileSchema = SchemaFactory.createForClass(CompensationProfile);

// ── Tax year rules (admin-editable; FBR slabs change every budget) ───────────
@Schema({ timestamps: true, collection: 'payroll_tax_years' })
export class TaxYearConfig {
  @Prop({ type: String, required: true, unique: true }) year: string;
  @Prop({ type: [Object], default: [] }) slabs: { from: number; to: number | null; fixed: number; rate: number }[];
  @Prop({ type: Object, default: null }) surcharge: { threshold: number; pct: number } | null;
  @Prop({ type: Object, default: () => ({ minimumWage: 37000, employeePct: 1, employerPct: 5 }) }) eobi: { minimumWage: number; employeePct: number; employerPct: number };
  /** True until someone with payroll.approve confirms the slabs against that year's Finance Act. Blocks approving runs. */
  @Prop({ type: Boolean, default: true }) needsVerification: boolean;
  @Prop({ type: String, default: null }) source: string | null;
  @Prop({ type: String, default: null }) verifiedBy: string | null;
  @Prop({ type: Date, default: null }) verifiedAt: Date | null;
  @Prop({ type: String, default: null }) notes: string | null;
}
export type TaxYearConfigDocument = HydratedDocument<TaxYearConfig>;
export const TaxYearConfigSchema = SchemaFactory.createForClass(TaxYearConfig);

// ── Claims ────────────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'payroll_claims' })
export class PayrollClaim {
  @Prop({ type: String, required: true, index: true }) adminId: string;
  @Prop({ type: String, enum: CLAIM_TYPES, required: true }) type: ClaimType;
  @Prop({ type: Date, required: true }) date: Date;
  @Prop({ type: String, required: true }) month: string;
  @Prop({ type: Number, default: null }) quantity: number | null;
  @Prop({ type: Number, default: null }) rate: number | null;
  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: String, default: '' }) description: string;
  /** Who was visited (customer, seller, school ...), free text, plus an optional store. */
  @Prop({ type: String, default: null }) visitedName: string | null;
  @Prop({ type: String, default: null }) storeId: string | null;
  @Prop({ type: Object, default: null }) receipt: { publicId: string; resourceType: string; fileName: string; mimeType: string } | null;
  @Prop({ type: Boolean, default: false }) taxable: boolean;
  @Prop({ type: String, enum: CLAIM_STATUSES, default: 'submitted', index: true }) status: ClaimStatus;
  @Prop({ type: String, default: null }) decidedBy: string | null;
  @Prop({ type: Date, default: null }) decidedAt: Date | null;
  @Prop({ type: String, default: null }) decisionNote: string | null;
  /** Set when an approved payroll run paid this claim. */
  @Prop({ type: String, default: null, index: true }) payrollRunId: string | null;
  @Prop({ type: String, default: null }) payrollMonth: string | null;
}
export type PayrollClaimDocument = HydratedDocument<PayrollClaim>;
export const PayrollClaimSchema = SchemaFactory.createForClass(PayrollClaim);
PayrollClaimSchema.index({ status: 1, payrollRunId: 1, date: 1 });

// ── Advances / loans to staff ─────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'payroll_advances' })
export class StaffAdvance {
  @Prop({ type: String, required: true, index: true }) adminId: string;
  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: Date, required: true }) date: Date;
  @Prop({ type: String, default: '' }) reason: string;
  /** Deducted from each payroll until cleared (0 = recover in full next payroll). */
  @Prop({ type: Number, default: 0 }) monthlyRecovery: number;
  @Prop({ type: Number, default: 0 }) recovered: number;
  /** Ledger account the advance was paid from (bank / cash). */
  @Prop({ type: String, default: '1010' }) paidFromAccount: string;
  @Prop({ type: String, enum: ADVANCE_STATUSES, default: 'submitted' }) status: AdvanceStatus;
  @Prop({ type: String, default: null }) preparedBy: string | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;
  @Prop({ type: String, default: null }) journalId: string | null;
  @Prop({ type: [Object], default: [] }) recoveries: { runId: string; month: string; amount: number; at: Date }[];
}
export type StaffAdvanceDocument = HydratedDocument<StaffAdvance>;
export const StaffAdvanceSchema = SchemaFactory.createForClass(StaffAdvance);

// ── Payroll runs ──────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'payroll_runs' })
export class PayrollRun {
  @Prop({ type: String, required: true }) month: string;
  @Prop({ type: String, required: true }) taxYear: string;
  @Prop({ type: String, enum: RUN_STATUSES, default: 'draft', index: true }) status: RunStatus;
  /** False once cancelled; the unique index keeps one live run per month. */
  @Prop({ type: Boolean, default: true }) live: boolean;
  /** One payslip per person (see payroll.util Payslip), plus who/what. */
  @Prop({ type: [Object], default: [] }) lines: any[];
  @Prop({ type: Object, default: null }) totals: { people: number; gross: number; deductions: number; net: number; employerCost: number; incomeTax: number } | null;
  @Prop({ type: String, default: null }) preparedBy: string | null;
  @Prop({ type: Date, default: null }) calculatedAt: Date | null;
  @Prop({ type: String, default: null }) submittedBy: string | null;
  @Prop({ type: Date, default: null }) submittedAt: Date | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;
  @Prop({ type: String, default: null }) accrualJournalId: string | null;
  @Prop({ type: String, default: null }) notes: string | null;
  @Prop({ type: [Object], default: [] }) history: { at: Date; by: string; action: string; note?: string | null }[];
}
export type PayrollRunDocument = HydratedDocument<PayrollRun>;
export const PayrollRunSchema = SchemaFactory.createForClass(PayrollRun);
// One live run per month (a cancelled run can be redone).
PayrollRunSchema.index({ month: 1 }, { unique: true, partialFilterExpression: { live: true } });
