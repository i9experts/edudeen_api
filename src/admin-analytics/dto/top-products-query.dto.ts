/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, IsMongoId } from 'class-validator';
import { AdminAnalyticsQueryDto } from './admin-analytics-query.dto';

// 'profit_margin' is intentionally NOT offered here either — same data-model gap as
// the seller module (no cost/COGS field on Product/ProductVariant).
export const TOP_PRODUCTS_SORTS = ['revenue', 'units_sold'] as const;

export class AdminTopProductsQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiProperty({ required: false, enum: TOP_PRODUCTS_SORTS, default: 'revenue' })
  @IsOptional()
  @IsIn(TOP_PRODUCTS_SORTS)
  sort?: string;

  @ApiProperty({ required: false, description: 'Optional — restrict to one category' })
  @IsOptional()
  @IsMongoId()
  categoryId?: string;
}
