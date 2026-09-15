/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString, IsOptional, IsBoolean, IsObject, ValidateNested, IsArray, IsIn,
} from 'class-validator';

class SeoMetaTemplateDto {
  @ApiProperty({ example: 'product' }) @IsString() key: string;
  @ApiProperty({ example: '{{productName}} — {{storeName}} | Edudeen' }) @IsString() titleTemplate: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() descriptionTemplate?: string;
}

class SeoRuleConfigDto {
  @ApiProperty({ enum: [
    'title_length', 'description_length', 'missing_alt_text', 'thin_content',
    'duplicate_meta', 'missing_canonical', 'broken_internal_link', 'missing_schema',
  ] })
  @IsIn([
    'title_length', 'description_length', 'missing_alt_text', 'thin_content',
    'duplicate_meta', 'missing_canonical', 'broken_internal_link', 'missing_schema',
  ])
  code: string;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() thresholds?: Record<string, number>;
  @ApiProperty({ required: false, enum: ['info', 'warning', 'error'] })
  @IsOptional() @IsIn(['info', 'warning', 'error']) severity?: string;
}

export class UpdatePlatformSeoSettingsDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() homepageTitle?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() homepageDescription?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() marketplaceTitle?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() marketplaceDescription?: string;

  @ApiProperty({ required: false, type: [SeoMetaTemplateDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SeoMetaTemplateDto)
  metaTemplates?: SeoMetaTemplateDto[];

  @ApiProperty({ required: false }) @IsOptional() @IsString() robotsTxtBody?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsObject() organizationSchema?: Record<string, any>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() websiteSchema?: Record<string, any>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() searchActionSchema?: Record<string, any>;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() aiSeoEnabled?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() aiSeoConfig?: Record<string, any>;

  @ApiProperty({ required: false, type: [SeoRuleConfigDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SeoRuleConfigDto)
  rules?: SeoRuleConfigDto[];
}
