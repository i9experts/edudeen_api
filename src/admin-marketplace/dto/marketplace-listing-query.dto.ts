/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsMongoId, IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';

export class MarketplaceListingQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @ApiProperty({ required: false, enum: ['active', 'inactive', 'draft', 'scheduled', 'pending_review', 'rejected', 'flagged'] })
  @IsOptional()
  @IsIn(['active', 'inactive', 'draft', 'scheduled', 'pending_review', 'rejected', 'flagged'])
  status?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
