/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BaseAnalyticsQueryDto } from './base-analytics-query.dto';
import { FREE_TO_PAID_WINDOWS, PRODUCT_TABLE_SORTS } from '../utils/product-performance.util';

/** Product table / Free->Paid: always ONE of the seller's own stores (ownership checked in the service). */
export class ProductTableQueryDto extends BaseAnalyticsQueryDto {
  @ApiProperty()
  @IsMongoId()
  storeId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiProperty({ required: false, enum: PRODUCT_TABLE_SORTS })
  @IsOptional()
  @IsIn(PRODUCT_TABLE_SORTS as unknown as string[])
  sort?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiProperty({ required: false, enum: FREE_TO_PAID_WINDOWS })
  @IsOptional()
  @Type(() => Number)
  @IsIn(FREE_TO_PAID_WINDOWS as unknown as number[])
  days?: number;
}
