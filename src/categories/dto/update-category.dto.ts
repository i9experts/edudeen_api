/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  Min,
  Max,
  IsString,
  IsOptional,
  MaxLength,
  IsUrl,
  IsBoolean,
} from 'class-validator';

export class UpdateCategoryDto {
  @ApiProperty({
    required: false,
    example: 'Electronics',
    description: 'Category name',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Category name cannot be more than 50 characters' })
  name?: string;

  @ApiProperty({
    required: false,
    example: 'Electronic devices and accessories',
    description: 'Category description',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Description cannot be more than 500 characters' })
  description?: string;

  @ApiProperty({
    required: false,
    example: 'https://example.com/images/electronics.jpg',
    description: 'Category image URL',
  })
  @IsOptional()
  @IsString()
  @IsUrl({}, { message: 'Image must be a valid URL' })
  image?: string;

  @ApiProperty({
    required: false,
    example: true,
    description: 'Category active status',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, example: 3, description: 'Display order (ascending)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;

  // ── Admin settings (validated in depth by cleanCategorySettings) ──
  @ApiProperty({ required: false, example: 'book-open', description: 'Icon name or emoji for the category tile' })
  @IsOptional()
  icon?: string | null;

  @ApiProperty({ required: false, example: '#1E7F5C', description: 'Tile colour (hex)' })
  @IsOptional()
  color?: string | null;

  @ApiProperty({ required: false, example: { ar: 'القرآن والتجويد', ur: 'قرآن و تجوید' }, description: 'Name in other languages' })
  @IsOptional()
  nameTranslations?: Record<string, string> | null;

  @ApiProperty({ required: false, example: ['digital', 'course'], description: 'What may be listed here (empty = everything)' })
  @IsOptional()
  allowedProductTypes?: string[] | null;

  @ApiProperty({ required: false, example: true, description: 'First publish always goes to admin review' })
  @IsOptional()
  @IsBoolean()
  requiresListingReview?: boolean;
}
