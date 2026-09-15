import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsNumber,
  IsNotEmpty,
  Min,
  Max,
} from 'class-validator';

export class CreateTestimonialDto {
  @ApiProperty({ example: 'Amina Raza', description: "The seller's name" })
  @IsString()
  @IsNotEmpty({ message: 'Seller name is required' })
  sellerName: string;

  @ApiProperty({ required: false, example: 'Amina Crafts', description: "The seller's store name" })
  @IsOptional()
  @IsString()
  storeName?: string;

  @ApiProperty({ example: 5, description: 'Rating out of 5' })
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ example: 'Edudeen made it so easy to launch my store...', description: 'The testimonial quote' })
  @IsString()
  @IsNotEmpty({ message: 'Testimonial text is required' })
  text: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isVerifiedSeller?: boolean;

  @ApiProperty({ required: false, default: 0, description: 'Display order (lower numbers appear first)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTestimonialDto extends PartialType(CreateTestimonialDto) {}
