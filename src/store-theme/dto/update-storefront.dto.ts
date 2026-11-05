/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export const MAX_FEATURED_PRODUCTS = 8;

export class UpdateStorefrontDto {
  @ApiProperty({ required: false, type: [String], description: 'Own active products, in display order, max 8' })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_FEATURED_PRODUCTS) @IsString({ each: true })
  featuredProductIds?: string[];

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showNewArrivals?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showBestSellers?: boolean;
}
