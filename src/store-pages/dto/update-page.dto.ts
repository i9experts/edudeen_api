/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

class StorePageSeoInputDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(70) metaTitle?: string;
  @ApiProperty({ required: false, deprecated: true, description: 'Superseded by metaDescription — kept as a one-release write-compat alias.' })
  @IsOptional() @IsString() @MaxLength(160) metaDesc?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(160) metaDescription?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) @Matches(/^https:\/\/\S+$/i, { message: 'ogImage must be an https URL' }) ogImage?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(70) ogTitle?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) ogDescription?: string;
  @ApiProperty({ required: false, enum: ['summary', 'summary_large_image'] })
  @IsOptional() @IsIn(['summary', 'summary_large_image']) twitterCard?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) canonicalUrlOverride?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() noindex?: boolean;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
}

export class UpdatePageDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(80) title?: string;

  @ApiProperty({ required: false, description: 'Custom pages only — the home page slug is fixed' })
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' }) @MaxLength(80)
  slug?: string;

  @ApiProperty({ required: false, type: StorePageSeoInputDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => StorePageSeoInputDto)
  seo?: StorePageSeoInputDto;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showInNav?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showInFooter?: boolean;
}
