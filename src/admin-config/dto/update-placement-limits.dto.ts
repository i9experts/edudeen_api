/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Min, Max } from 'class-validator';

export class UpdatePlacementLimitsDto {
  @ApiProperty({ required: false, example: 4 }) @IsOptional() @IsInt() @Min(1) @Max(50) homepageHero?: number;
  @ApiProperty({ required: false, example: 4 }) @IsOptional() @IsInt() @Min(1) @Max(50) marketplaceHero?: number;
  @ApiProperty({ required: false, example: 4 }) @IsOptional() @IsInt() @Min(1) @Max(50) educationHero?: number;
  @ApiProperty({ required: false, example: 4 }) @IsOptional() @IsInt() @Min(1) @Max(50) categoryHero?: number;
  @ApiProperty({ required: false, example: 4 }) @IsOptional() @IsInt() @Min(1) @Max(50) storeHero?: number;
  @ApiProperty({ required: false, example: 8 }) @IsOptional() @IsInt() @Min(1) @Max(50) storeFeaturedProducts?: number;
}
