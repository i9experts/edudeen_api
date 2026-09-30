/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { STORE_BANNER_TYPES, StoreBannerType, STORE_BANNER_LINK_TYPES, StoreBannerLinkType } from '../schemas/store-banner.schema';

export class CreateStoreBannerDto {
  @ApiProperty({ enum: STORE_BANNER_TYPES, default: 'hero' })
  @IsOptional()
  @IsIn(STORE_BANNER_TYPES)
  type?: StoreBannerType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ctaLabel?: string;

  @ApiProperty({ enum: STORE_BANNER_LINK_TYPES, default: 'external' })
  @IsOptional()
  @IsIn(STORE_BANNER_LINK_TYPES)
  linkType?: StoreBannerLinkType;

  @ApiProperty({ required: false, description: 'Product/category id, collection id, or an external URL depending on linkType' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  linkTarget?: string;

  @ApiProperty({ required: false, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({ required: false, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  priority?: number;

  @ApiProperty({ required: false, description: 'ISO date — leave empty to go live immediately' })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiProperty({ required: false, description: 'ISO date — leave empty for no expiry' })
  @IsOptional()
  @IsDateString()
  endAt?: string;
}
