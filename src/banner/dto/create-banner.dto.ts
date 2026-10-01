/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUrl, IsNumber, IsIn, IsArray, IsDateString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PROMOTION_PLACEMENTS, PromotionPlacement } from '../../common/promotion-placements.const';

export class CreateBannerDto {
  @ApiProperty({ required: false, enum: PROMOTION_PLACEMENTS, default: 'marketplaceHero', description: 'Deprecated — use `placements` (array) instead. Kept for older callers.' })
  @IsOptional()
  @IsIn(PROMOTION_PLACEMENTS)
  placement?: PromotionPlacement;

  @ApiProperty({ required: false, enum: PROMOTION_PLACEMENTS, isArray: true, description: 'One banner can run on more than one placement at once.' })
  @IsOptional()
  @IsArray()
  @IsIn(PROMOTION_PLACEMENTS, { each: true })
  placements?: PromotionPlacement[];

  @ApiProperty({ required: false, description: 'ISO date — leave empty to go live immediately' })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiProperty({ required: false, description: 'ISO date — leave empty for no expiry' })
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiProperty({
    required: false,
    example: 'https://res.cloudinary.com/demo/image/upload/banner.jpg',
    description: 'Direct image URL — use this OR upload a file via /upload',
  })
  @IsOptional()
  @IsUrl({}, { message: 'bannerImage must be a valid URL' })
  bannerImage?: string;

  @ApiProperty({
    required: false,
    example: 'https://example.com/sale',
    description: 'URL to open when the banner is tapped',
  })
  @IsOptional()
  @IsUrl({}, { message: 'urlOnTap must be a valid URL' })
  urlOnTap?: string;

  @ApiProperty({ required: false, example: 0, description: 'Display order (0 = first)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;
}
