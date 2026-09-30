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
}
