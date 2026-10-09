/* eslint-disable prettier/prettier */
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsObject,
  IsNotEmpty, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min,
  ValidateIf, IsDefined,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export const TONES = ['professional', 'friendly', 'academic'] as const;
export const CAMPAIGN_GOALS = ['promo', 'newsletter', 'abandoned_cart', 'new_arrival', 'restock', 'thank_you'] as const;
export const ENHANCEMENT_TYPES = ['upscale', 'denoise', 'background_cleanup'] as const;

/** Shared by every generate DTO — "Regenerate" links the new row to the prior one's session. */
class BaseGenerateDto {
  @IsOptional() @IsMongoId()
  regenerateFromId?: string;
}

export class GenerateListingDto extends BaseGenerateDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  productType: string;

  /** Accepts a single string or string[] per the contract. */
  @IsDefined()
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? (value as unknown[]) : typeof value === 'string' ? value.slice(0, 500) : null))
  @ValidateIf((o) => Array.isArray(o.keywords))
  @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true })
  keywords: string | string[];

  @IsIn(TONES)
  tone: (typeof TONES)[number];

  @IsOptional() @IsMongoId()
  productId?: string;
}

export class GenerateSeoDto extends BaseGenerateDto {
  @IsOptional() @IsMongoId()
  productId?: string;

  @ValidateIf((o) => !o.productId)
  @IsString() @IsNotEmpty() @MaxLength(200)
  title?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true })
  currentTags?: string[];
}

export class GenerateEmailDto extends BaseGenerateDto {
  @IsIn(CAMPAIGN_GOALS)
  campaignGoal: (typeof CAMPAIGN_GOALS)[number];

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsMongoId({ each: true })
  productIds?: string[];

  @IsIn(TONES)
  tone: (typeof TONES)[number];
}

export class GenerateWorksheetDto extends BaseGenerateDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  subject: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  gradeLevel: string;

  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(100, { each: true })
  topics: string[];

  @Type(() => Number) @IsInt() @Min(1) @Max(40)
  questionCount: number;

  @IsBoolean()
  includeAnswerKey: boolean;
}

/** Public "Try AI Worksheet Builder for free" trial — no seller/store, no credits.
 *  Capped lower than the seller tool (max 6 questions vs 40) to bound provider cost. */
export class GenerateWorksheetTrialDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  subject: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  gradeLevel: string;

  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(100, { each: true })
  topics: string[];

  @Type(() => Number) @IsInt() @Min(1) @Max(6)
  questionCount: number;

  @IsBoolean()
  includeAnswerKey: boolean;
}

export class GeneratePriceDto extends BaseGenerateDto {
  @IsOptional() @IsMongoId()
  productId?: string;

  /** Raw mode when no productId: category id + free-form attributes. */
  @ValidateIf((o) => !o.productId)
  @IsMongoId()
  categoryId?: string;

  @IsOptional() @IsString() @MaxLength(500)
  attributes?: string;
}

export class GenerateImageEnhanceDto extends BaseGenerateDto {
  /**
   * URL of an already-uploaded image (the app uploads via the existing
   * api/upload → Cloudinary flow, which enforces 5MB + jpg/png/webp before
   * anything reaches a provider).
   */
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  @Matches(/\.(jpg|jpeg|png|webp)(\?.*)?$/i, { message: 'imageUrl must point to a jpg, jpeg, png, or webp image' })
  imageUrl: string;

  @IsIn(ENHANCEMENT_TYPES)
  enhancementType: (typeof ENHANCEMENT_TYPES)[number];
}

export class AcceptGenerationDto {
  /** Write the accepted output into the linked product record (listing_writer / seo_booster only). */
  @IsOptional() @IsBoolean()
  applyToProduct?: boolean;

  /** Overrides the generation's own productId when applying. */
  @IsOptional() @IsMongoId()
  productId?: string;

  /** The seller's manual edits of the AI draft (title/description/tags). Re-sanitised server-side before it touches the product. */
  @IsOptional() @IsObject()
  edits?: Record<string, unknown>;
}
