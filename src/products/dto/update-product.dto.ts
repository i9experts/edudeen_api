import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  MaxLength,
  IsNumber,
  Min,
  IsMongoId,
  IsOptional,
  IsArray,
  IsUrl,
  IsBoolean,
  ArrayMaxSize,
} from 'class-validator';

export class UpdateProductDto {
  @ApiProperty({
    required: false,
    example: 'Samsung Galaxy S24 Ultra',
    description: 'Product name',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Product name cannot exceed 100 characters' })
  name?: string;

  @ApiProperty({
    required: false,
    example: 'Updated product description',
    description: 'Product description',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Description cannot exceed 1000 characters' })
  description?: string;

  @ApiProperty({
    required: false,
    example: 1199.99,
    description: 'Product price',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'Price must be a positive number' })
  price?: number;

  @ApiProperty({
    required: false,
    example: '67a1b2c3d4e5f6g7h8i9j0k1',
    description: 'Category ID',
  })
  @IsOptional()
  @IsMongoId({ message: 'Invalid category ID' })
  category?: string;

  @ApiProperty({
    required: false,
    example: 'Samsung',
    description: 'Product brand',
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiProperty({
    required: false,
    example: [
      'https://example.com/images/product1.jpg',
      'https://example.com/images/product2.jpg',
    ],
    description: 'Array of product image URLs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: 'A product can have at most 20 images' })
  @IsUrl({}, { each: true, message: 'Each image must be a valid URL' })
  images?: string[];

  @ApiProperty({
    required: false,
    example: 75,
    description: 'Stock quantity',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'Stock must be a non-negative number' })
  stock?: number;

  @ApiProperty({
    required: false,
    example: true,
    description: 'Is product featured',
  })
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @ApiProperty({
    required: false,
    example: true,
    description: 'Is product active',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Admin campaigns (sales) this product joins. Max 10; unknown/ended ones are dropped by the service.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsMongoId({ each: true })
  campaignIds?: string[];
}
