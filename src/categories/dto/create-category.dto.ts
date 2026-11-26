import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  image?: string;

  @IsOptional()
  description?: string;

  @IsOptional()
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
