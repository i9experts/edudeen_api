/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

export class PremiumBenefitsDto {
  @IsOptional() @IsInt() @Min(8) @Max(100) childrenLimit?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(168) earlyAccessHours?: number;
  /** 0 = no monthly coupon. */
  @IsOptional() @IsNumber() @Min(0) @Max(100000) monthlyCouponValue?: number;
  @IsOptional() @IsIn(['percentage', 'fixed']) monthlyCouponType?: 'percentage' | 'fixed';
  @IsOptional() @IsBoolean() prioritySupport?: boolean;
}

export class CreatePremiumPlanDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsNumber() @Min(0) @Max(100000) monthlyPriceUSD: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1000000) yearlyPriceUSD?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => PremiumBenefitsDto) benefits?: PremiumBenefitsDto;
}

export class UpdatePremiumPlanDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) monthlyPriceUSD?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1000000) yearlyPriceUSD?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => PremiumBenefitsDto) benefits?: PremiumBenefitsDto;
}

export class SubscribePremiumDto {
  @IsMongoId() planId: string;
  @IsEnum(['monthly', 'yearly']) interval: 'monthly' | 'yearly';
}

export class SubmitPremiumProofDto {
  @IsOptional() @IsString() @MaxLength(120) transactionReference?: string;
  @IsOptional() @IsString() @MaxLength(120) senderName?: string;
}

export class GrantPremiumDto {
  @IsOptional() @IsMongoId() userId?: string;
  @IsOptional() @IsString() @MaxLength(254) email?: string;
  @IsMongoId() planId: string;
  /** Duration in days (1-366). */
  @IsInt() @Min(1) @Max(366) days: number;
}

export class RevokePremiumDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class RejectPremiumPaymentDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class PremiumPlatformDiscountDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(30) percent?: number;
}

/** Admin -> Premium -> Platform offer. Every field optional (merged onto the saved settings). */
export class UpdatePremiumSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => PremiumPlatformDiscountDto) platformDiscount?: PremiumPlatformDiscountDto;
  @IsOptional() @IsNumber() @Min(0) @Max(30) premiumSellerFeePercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(50) minGapPercent?: number;
}