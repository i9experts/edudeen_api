/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, IsMongoId } from 'class-validator';
import { AdminAnalyticsQueryDto } from './admin-analytics-query.dto';

export class AdminProductPerformanceQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({ required: false, description: 'Optional — restrict to one category' })
  @IsOptional()
  @IsMongoId()
  categoryId?: string;
}
