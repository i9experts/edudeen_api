/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, IsDateString, IsArray, ArrayMaxSize, IsMongoId, IsInt, IsBoolean, Min, Max } from 'class-validator';

export class CreateCouponDto {
  @ApiProperty({ example: 'BACK2SCHOOL' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ enum: ['percentage', 'fixed'] })
  @IsEnum(['percentage', 'fixed'])
  discountType: 'percentage' | 'fixed';

  @ApiProperty({ example: 20 })
  @IsNumber()
  @Min(0)
  discountValue: number;

  @ApiProperty({ required: false, example: 50 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @ApiProperty({ required: false, example: 100 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  usageLimit?: number;

  @ApiProperty({ required: false, example: '2026-06-30' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiProperty({ required: false, example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  perCustomerLimit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  firstOrderOnly?: boolean;

  @ApiProperty({ required: false, enum: ['public', 'private'] })
  @IsOptional()
  @IsEnum(['public', 'private'])
  visibility?: 'public' | 'private';
}
