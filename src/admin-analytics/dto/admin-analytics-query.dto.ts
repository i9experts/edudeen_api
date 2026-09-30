/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsMongoId } from 'class-validator';
import { BaseAnalyticsQueryDto, RANGE_PRESETS } from '../../analytics/dto/base-analytics-query.dto';

export { RANGE_PRESETS };

export const GRANULARITY_OVERRIDES = ['day', 'week', 'month'] as const;

/**
 * Platform-wide analytics query — unlike the seller `AnalyticsQueryDto`, `storeId` is
 * NOT required: admin dashboards aggregate across every seller/store by default.
 * `storeId`/`sellerId` are optional drill-down filters (e.g. "show me this one seller's
 * numbers on the admin dashboard" without needing the seller's own credentials).
 */
export class AdminAnalyticsQueryDto extends BaseAnalyticsQueryDto {
  @ApiProperty({ required: false, description: 'Optional — scope the platform-wide query down to a single store' })
  @IsOptional()
  @IsMongoId()
  storeId?: string;

  @ApiProperty({ required: false, description: 'Optional — scope the platform-wide query down to a single seller (all of their stores)' })
  @IsOptional()
  @IsMongoId()
  sellerId?: string;

  @ApiProperty({ required: false, enum: GRANULARITY_OVERRIDES, description: 'Optional — force a bucket size on time-series endpoints instead of the auto-selected one (day ≤31d, week ≤90d, month beyond)' })
  @IsOptional()
  @IsIn(GRANULARITY_OVERRIDES)
  granularity?: string;
}
