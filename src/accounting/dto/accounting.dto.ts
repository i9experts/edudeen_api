/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, ASSET_CATEGORIES, PARTY_TYPES } from '../accounting.constants';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAccountDto {
  @IsString() @Matches(/^\d{3,6}$/) code: string;
  @IsString() @MaxLength(120) name: string;
  @IsIn(ACCOUNT_TYPES as unknown as string[]) type: string;
  @IsIn(ACCOUNT_SUBTYPES as unknown as string[]) subtype: string;
  @IsOptional() @IsString() @MaxLength(6) parentCode?: string | null;
  @IsOptional() @IsString() @MaxLength(400) description?: string | null;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/i) currency?: string | null;
}

export class UpdateAccountDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(400) description?: string | null;
  @IsOptional() @IsString() @MaxLength(6) parentCode?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsIn(ACCOUNT_SUBTYPES as unknown as string[]) subtype?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/i) currency?: string | null;
}

export class PartyDto {
  @IsIn(PARTY_TYPES as unknown as string[]) type: (typeof PARTY_TYPES)[number];
  @IsString() @MaxLength(64) id: string;
  @IsOptional() @IsString() @MaxLength(160) name?: string | null;
}

export class JournalLineDto {
  @IsString() @MaxLength(6) accountCode: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1e12) debit?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1e12) credit?: number;
  @IsOptional() @ValidateNested() @Type(() => PartyDto) party?: PartyDto | null;
  @IsOptional() @IsString() @MaxLength(64) storeId?: string | null;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
}

export class CreateJournalDto {
  @IsOptional() @Matches(DAY) date?: string;
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => JournalLineDto) lines: JournalLineDto[];
}

export class UpdateJournalDto {
  @IsOptional() @Matches(DAY) date?: string;
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => JournalLineDto) lines?: JournalLineDto[];
}

export class ReasonDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string | null;
}

export class ReverseDto {
  @IsOptional() @Matches(DAY) date?: string | null;
  @IsOptional() @IsString() @MaxLength(500) memo?: string | null;
}

export class VendorDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(160) contact?: string | null;
  @IsOptional() @IsString() @MaxLength(160) email?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateAssetDto {
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsIn(ASSET_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @IsString() @MaxLength(60) tag?: string | null;
  @Matches(DAY) purchaseDate: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1e12) cost: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1e12) salvage?: number;
  @IsNumber() @Min(1) @Max(600) usefulLifeMonths: number;
  @IsOptional() @IsString() @MaxLength(6) assetAccount?: string;
  @IsOptional() @IsString() @MaxLength(6) depreciationExpenseAccount?: string;
  @IsOptional() @IsString() @MaxLength(6) accumulatedDepreciationAccount?: string;
  @IsOptional() @IsBoolean() postPurchase?: boolean;
  @IsOptional() @IsString() @MaxLength(6) purchaseCreditAccount?: string;
  @IsOptional() @IsString() @MaxLength(400) notes?: string | null;
}

export class UpdateAssetDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(60) tag?: string | null;
  @IsOptional() @IsString() @MaxLength(400) notes?: string | null;
  @IsOptional() @Matches(DAY) purchaseDate?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1e12) cost?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1e12) salvage?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(600) usefulLifeMonths?: number;
}

export class DisposeAssetDto {
  @Matches(DAY) date: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1e12) proceeds?: number;
  @IsOptional() @IsString() @MaxLength(6) proceedsAccount?: string;
}

export class BackfillDto {
  @IsOptional() @Matches(DAY) from?: string;
}

// ── Settlements ─────────────────────────────────────────────────────────────────
export class StripeSyncDto {
  /** Re-read Stripe from this day (backfill); omitted = from the last sync. */
  @IsOptional() @Matches(DAY) from?: string;
}

export class StripeSettingsDto {
  @IsString() @Matches(/^\d{3,6}$/) payoutBankAccount: string;
}

export class CodLineDto {
  @IsString() @MaxLength(60) trackingNumber: string;
  @Type(() => Number) @IsNumber() @Min(-10_000_000) @Max(10_000_000) codCollected: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(10_000_000) charges?: number;
}

export class CodRemittanceUpdateDto {
  @IsOptional() @IsIn(['tcs', 'leopards', 'postex', 'other']) courier?: string;
  @IsOptional() @IsString() @MaxLength(80) statementRef?: string | null;
  @IsOptional() @Matches(DAY) remittanceDate?: string;
  @IsOptional() @IsString() @Matches(/^\d{3,6}$/) bankAccount?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100_000_000) otherDeductions?: number;
  @IsOptional() @IsString() @Matches(/^\d{3,6}$/) otherDeductionsAccount?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000_000) netReceived?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  /** Add or replace parcels (by tracking number). */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CodLineDto) upsertLines?: CodLineDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) @MaxLength(60, { each: true }) removeTrackings?: string[];
}
