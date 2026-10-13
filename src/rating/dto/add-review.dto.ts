/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, Min, Max, IsOptional, IsBoolean, IsArray, IsIn } from 'class-validator';

export class AddReviewDto {

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  productVariantId?: string;

  @ApiProperty({ required: false, description: 'Order this review is tied to — enables the "Verified Purchase" badge' })
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media?: string[];

  @ApiProperty({ required: false, enum: ['home', 'classroom', 'school'] })
  @IsOptional()
  @IsIn(['home', 'classroom', 'school'])
  usedFor?: 'home' | 'classroom' | 'school';

}
