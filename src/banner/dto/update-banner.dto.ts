/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUrl, IsBoolean, IsNumber, IsIn, IsArray, IsDateString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IsLinkTarget } from '../../common/link-target.util';
import { PROMOTION_PLACEMENTS, PromotionPlacement } from '../../common/promotion-placements.const';

export class UpdateBannerDto {
  @ApiProperty({ required: false, enum: PROMOTION_PLACEMENTS, description: 'Deprecated — use `placements` (array) instead. Kept for older callers.' })
  @IsOptional()
  @IsIn(PROMOTION_PLACEMENTS)
  placement?: PromotionPlacement;

  @ApiProperty({ required: false, enum: PROMOTION_PLACEMENTS, isArray: true, description: 'One banner can run on more than one placement at once.' })
  @IsOptional()
  @IsArray()
  @IsIn(PROMOTION_PLACEMENTS, { each: true })
  placements?: PromotionPlacement[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startAt?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endAt?: string | null;

  @ApiProperty({ required: false, example: 'https://res.cloudinary.com/demo/image/upload/banner.jpg' })
  @IsOptional()
  @IsUrl({}, { message: 'bannerImage must be a valid URL' })
  bannerImage?: string;

  @ApiProperty({ required: false, example: 'https://example.com/sale' })
  @IsOptional()
  @IsLinkTarget()
  urlOnTap?: string;

  @ApiProperty({ required: false, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({ required: false, description: 'Save without publishing: the banner stays a draft (never shown) until published.' })
  @IsOptional()
  @IsBoolean()
  saveAsDraft?: boolean;

  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
