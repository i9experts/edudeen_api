/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsNumber, IsOptional, IsString, Min, ValidateNested, Max, MaxLength, ArrayMaxSize } from 'class-validator';

export class FestivalPricingOverrideDto {
  @ApiProperty() @IsString() @MaxLength(80) name: string;
  @ApiProperty() @IsDateString() startAt: string;
  @ApiProperty() @IsDateString() endAt: string;
  @ApiProperty({ example: 49.99 }) @IsNumber() @Min(0) @Max(1000000) rate: number;
}

export class PlacementRateCardDto {
  @ApiProperty({ required: false, example: 5 }) @IsOptional() @IsNumber() @Min(0) @Max(1000000) hourly?: number;
  @ApiProperty({ required: false, example: 25 }) @IsOptional() @IsNumber() @Min(0) @Max(1000000) daily?: number;
  @ApiProperty({ required: false, example: 140 }) @IsOptional() @IsNumber() @Min(0) @Max(1000000) weekly?: number;
  @ApiProperty({ required: false, example: 450 }) @IsOptional() @IsNumber() @Min(0) @Max(1000000) monthly?: number;
  @ApiProperty({ required: false, example: 1.25 }) @IsOptional() @IsNumber() @Min(0.1) @Max(20) weekendMultiplier?: number;
  @ApiProperty({ required: false, example: 1.5 }) @IsOptional() @IsNumber() @Min(0.1) @Max(20) peakMultiplier?: number;
  @ApiProperty({ required: false, type: [FestivalPricingOverrideDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => FestivalPricingOverrideDto)
  festivalOverrides?: FestivalPricingOverrideDto[];
}

/** One rate card per placement — placements are the same fixed set as `PROMOTION_PLACEMENTS`. */
export class UpdatePromotionPricingDto {
  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  homepageHero?: PlacementRateCardDto;

  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  marketplaceHero?: PlacementRateCardDto;

  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  educationHero?: PlacementRateCardDto;

  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  categoryHero?: PlacementRateCardDto;
}
