/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateBlogPostDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) title: string;

  @ApiProperty({ description: 'Lowercase, hyphenated — served at /:slug/blog/:slug' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' })
  @MaxLength(100)
  slug: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(240) excerpt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) @Matches(/^https:\/\/\S+$/i, { message: 'coverImage must be an https URL' }) coverImage?: string;
}
