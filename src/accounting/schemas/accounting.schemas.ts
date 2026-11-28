/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  ACCOUNT_SUBTYPES, ACCOUNT_TYPES, ASSET_CATEGORIES, JOURNAL_STATUSES, PARTY_TYPES, SOURCE_TYPES,
  type AccountSubtype, type AccountType, type JournalStatus, type PartyType, type SourceType,
} from '../accounting.constants';

// ── Chart of accounts ─────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'acct_accounts' })
export class Account {
  @Prop({ type: String, required: true, unique: true, trim: true }) code: string;
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, enum: ACCOUNT_TYPES, required: true }) type: AccountType;
  @Prop({ type: String, enum: ACCOUNT_SUBTYPES, required: true }) subtype: AccountSubtype;
  @Prop({ type: String, default: null }) parentCode: string | null;
  @Prop({ type: String, default: null }) description: string | null;
  /** Seeded by Edudeen; used by auto-posting rules, so it can be renamed but not deactivated. */
  @Prop({ type: Boolean, default: false }) isSystem: boolean;
  @Prop({ type: Boolean, default: true }) isActive: boolean;
  /** Optional: an account held in a foreign currency (e.g. a USD bank account). Lines still post PKR. */
  @Prop({ type: String, default: null }) currency: string | null;
}
export type AccountDocument = HydratedDocument<Account>;
export const AccountSchema = SchemaFactory.createForClass(Account);

// ── Journal entries ───────────────────────────────────────────────────────────
@Schema({ _id: false })
export class JournalParty {
  @Prop({ type: String, enum: PARTY_TYPES, required: true }) type: PartyType;
  @Prop({ type: String, required: true }) id: string;
  @Prop({ type: String, default: null }) name: string | null;
}
export const JournalPartySchema = SchemaFactory.createForClass(JournalParty);

@Schema({ _id: false })
export class JournalLine {
  @Prop({ type: String, required: true }) accountCode: string;
  /** Base currency (PKR), 2 dp. Exactly one of debit/credit is > 0. */
  @Prop({ type: Number, default: 0 }) debit: number;
  @Prop({ type: Number, default: 0 }) credit: number;
  /** The source document's currency and amount, and the rate used (PKR per 1 unit). */
  @Prop({ type: String, default: 'PKR' }) currency: string;
  @Prop({ type: Number, default: null }) amountOriginal: number | null;
  @Prop({ type: Number, default: null }) fxRate: number | null;
  @Prop({ type: JournalPartySchema, default: null }) party: JournalParty | null;
  @Prop({ type: String, default: null }) storeId: string | null;
  @Prop({ type: String, default: null }) description: string | null;
}
export const JournalLineSchema = SchemaFactory.createForClass(JournalLine);

@Schema({ _id: false })
export class JournalSource {
  @Prop({ type: String, enum: SOURCE_TYPES, required: true }) type: SourceType;
  @Prop({ type: String, required: true }) id: string;
  /** Human reference shown in reports, e.g. an order or invoice number. */
  @Prop({ type: String, default: null }) ref: string | null;
}
export const JournalSourceSchema = SchemaFactory.createForClass(JournalSource);

@Schema({ timestamps: true, collection: 'acct_journal_entries' })
export class JournalEntry {
  /** JV-2026-27-000123; assigned when the entry is posted (drafts carry a DRAFT-... number). */
  @Prop({ type: String, required: true, unique: true }) number: string;
  @Prop({ type: Date, required: true }) date: Date;
  @Prop({ type: String, required: true }) period: string;
  @Prop({ type: String, required: true }) fiscalYear: string;
  @Prop({ type: String, default: '' }) memo: string;
  @Prop({ type: String, enum: JOURNAL_STATUSES, default: 'draft' }) status: JournalStatus;
  @Prop({ type: String, enum: ['manual', 'auto', 'opening'], default: 'manual' }) kind: 'manual' | 'auto' | 'opening';
  @Prop({ type: JournalSourceSchema, default: null }) source: JournalSource | null;
  @Prop({ type: [JournalLineSchema], default: [] }) lines: JournalLine[];
  @Prop({ type: Number, default: 0 }) total: number;
  @Prop({ type: String, default: null }) preparedBy: string | null;
  @Prop({ type: String, default: null }) submittedBy: string | null;
  @Prop({ type: Date, default: null }) submittedAt: Date | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: Date, default: null }) postedAt: Date | null;
  @Prop({ type: String, default: null }) reversalOf: string | null;
  @Prop({ type: String, default: null }) reversedBy: string | null;
  @Prop({ type: String, default: null }) voidReason: string | null;
  /** Posting-engine notes, e.g. "FX: nearest earlier rate used" or "period closed: posted on ...". */
  @Prop({ type: [String], default: [] }) flags: string[];
}
export type JournalEntryDocument = HydratedDocument<JournalEntry>;
export const JournalEntrySchema = SchemaFactory.createForClass(JournalEntry);
// One journal per auto-posting source: a re-run or a second instance can never post the same thing twice.
JournalEntrySchema.index({ 'source.type': 1, 'source.id': 1 }, { unique: true, partialFilterExpression: { 'source.type': { $type: 'string' } } });
JournalEntrySchema.index({ status: 1, date: 1 });
JournalEntrySchema.index({ status: 1, 'lines.accountCode': 1, date: 1 });
JournalEntrySchema.index({ 'lines.party.type': 1, 'lines.party.id': 1, date: 1 });
JournalEntrySchema.index({ period: 1, status: 1 });

// ── Periods ───────────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'acct_periods' })
export class AccountingPeriod {
  @Prop({ type: String, required: true, unique: true }) period: string;
  @Prop({ type: String, enum: ['open', 'closed'], default: 'open' }) status: 'open' | 'closed';
  @Prop({ type: String, default: null }) closedBy: string | null;
  @Prop({ type: Date, default: null }) closedAt: Date | null;
  @Prop({ type: [Object], default: [] }) history: { action: 'closed' | 'reopened'; by: string; at: Date; note?: string | null }[];
}
export type AccountingPeriodDocument = HydratedDocument<AccountingPeriod>;
export const AccountingPeriodSchema = SchemaFactory.createForClass(AccountingPeriod);

// ── Fixed assets ──────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'acct_fixed_assets' })
export class FixedAsset {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, enum: ASSET_CATEGORIES, default: 'other' }) category: string;
  @Prop({ type: String, default: null }) tag: string | null;
  @Prop({ type: Date, required: true }) purchaseDate: Date;
  @Prop({ type: Number, required: true }) cost: number;
  @Prop({ type: Number, default: 0 }) salvage: number;
  @Prop({ type: Number, required: true }) usefulLifeMonths: number;
  @Prop({ type: String, enum: ['straight_line'], default: 'straight_line' }) method: 'straight_line';
  @Prop({ type: String, required: true }) assetAccount: string;
  @Prop({ type: String, required: true }) depreciationExpenseAccount: string;
  @Prop({ type: String, required: true }) accumulatedDepreciationAccount: string;
  @Prop({ type: String, enum: ['active', 'disposed'], default: 'active' }) status: 'active' | 'disposed';
  @Prop({ type: Date, default: null }) disposedAt: Date | null;
  @Prop({ type: Number, default: null }) disposalProceeds: number | null;
  @Prop({ type: String, default: null }) notes: string | null;
  @Prop({ type: String, default: null }) createdBy: string | null;
}
export type FixedAssetDocument = HydratedDocument<FixedAsset>;
export const FixedAssetSchema = SchemaFactory.createForClass(FixedAsset);

// ── Vendors ───────────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: 'acct_vendors' })
export class Vendor {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, default: null }) contact: string | null;
  @Prop({ type: String, default: null }) email: string | null;
  @Prop({ type: String, default: null }) phone: string | null;
  @Prop({ type: String, default: null }) taxId: string | null;
  @Prop({ type: Boolean, default: true }) isActive: boolean;
}
export type VendorDocument = HydratedDocument<Vendor>;
export const VendorSchema = SchemaFactory.createForClass(Vendor);

// ── Posting engine bookkeeping ────────────────────────────────────────────────
/** Atomic per-fiscal-year journal number counter. */
@Schema({ collection: 'acct_counters' })
export class AcctCounter {
  @Prop({ type: String, required: true, unique: true }) key: string;
  @Prop({ type: Number, default: 0 }) seq: number;
}
export const AcctCounterSchema = SchemaFactory.createForClass(AcctCounter);

/** Per-source posting outcome for things that did NOT become a journal (skipped, or failed and to retry). */
@Schema({ timestamps: true, collection: 'acct_source_marks' })
export class AcctSourceMark {
  @Prop({ type: String, required: true }) sourceType: string;
  @Prop({ type: String, required: true }) sourceId: string;
  @Prop({ type: String, enum: ['skipped', 'error'], required: true }) status: 'skipped' | 'error';
  @Prop({ type: String, default: null }) reason: string | null;
  @Prop({ type: Number, default: 0 }) attempts: number;
  @Prop({ type: Date, default: null }) sourceDate: Date | null;
}
export type AcctSourceMarkDocument = HydratedDocument<AcctSourceMark>;
export const AcctSourceMarkSchema = SchemaFactory.createForClass(AcctSourceMark);
AcctSourceMarkSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });
AcctSourceMarkSchema.index({ status: 1, sourceType: 1 });

/** Watermark + last-run stats per source type. */
@Schema({ timestamps: true, collection: 'acct_posting_state' })
export class AcctPostingState {
  @Prop({ type: String, required: true, unique: true }) sourceType: string;
  @Prop({ type: Date, default: null }) watermark: Date | null;
  @Prop({ type: Date, default: null }) lastRunAt: Date | null;
  @Prop({ type: Object, default: null }) lastRun: { posted: number; skipped: number; errors: number; ms: number } | null;
}
export type AcctPostingStateDocument = HydratedDocument<AcctPostingState>;
export const AcctPostingStateSchema = SchemaFactory.createForClass(AcctPostingState);

/** Singleton (key 'default'): finance-team sharing settings. The monthly finance-pack e-mail is OFF by default. */
@Schema({ timestamps: true, collection: 'accounting_settings' })
export class AcctSettings {
  @Prop({ type: String, required: true, unique: true, default: 'default' }) key: string;
  @Prop({ type: Boolean, default: false }) financePackEmailEnabled: boolean;
  @Prop({ type: [String], default: [] }) financePackRecipients: string[];
  /** Last month a finance-pack notice went out for ('YYYY-MM'), so each month is sent once. */
  @Prop({ type: String, default: null }) financePackLastSent: string | null;
  /** COA code Stripe payouts land in (Stripe settlement sync). null = Bank — main (1010). */
  @Prop({ type: String, default: null }) stripePayoutBankAccount: string | null;
  /** Day of the following month each statutory authority is due (statutory.util DEFAULT_DUE_DAYS when unset). */
  @Prop({ type: Object, default: null }) statutoryDueDays: Record<string, number> | null;
  /** E-mail the finance recipients 5 days before a tax / EOBI payment is due and when it becomes overdue. */
  @Prop({ type: Boolean, default: true }) statutoryRemindersEnabled: boolean;
  @Prop({ type: String, default: null }) updatedBy: string | null;
}
export type AcctSettingsDocument = HydratedDocument<AcctSettings>;
export const AcctSettingsSchema = SchemaFactory.createForClass(AcctSettings);
