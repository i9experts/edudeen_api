/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateBlogPostDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) title?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' }) @MaxLength(100)
  slug?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(240) excerpt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) @Matches(/^https:\/\/\S+$/i, { message: 'coverImage must be an https URL' }) coverImage?: string;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
}
