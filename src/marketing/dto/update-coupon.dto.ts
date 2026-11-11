/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsNumber, IsOptional, IsDateString, IsBoolean, IsArray, ArrayMaxSize, IsMongoId, IsInt, ValidateIf, Min, Max } from 'class-validator';

export class UpdateCouponDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ required: false, enum: ['percentage', 'fixed'] })
  @IsOptional()
  @IsEnum(['percentage', 'fixed'])
  discountType?: 'percentage' | 'fixed';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountValue?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  usageLimit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, enum: ['store', 'categories', 'products'] })
  @IsOptional()
  @IsEnum(['store', 'categories', 'products'])
  appliesTo?: 'store' | 'categories' | 'products';

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  targetIds?: string[];

  // null clears the start date / per-customer limit
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  startsAt?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(1000)
  perCustomerLimit?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  firstOrderOnly?: boolean;

  @ApiProperty({ required: false, enum: ['public', 'private'] })
  @IsOptional()
  @IsEnum(['public', 'private'])
  visibility?: 'public' | 'private';
}
