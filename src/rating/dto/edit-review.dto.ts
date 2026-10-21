/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min, Max, IsOptional, IsArray, IsIn, MaxLength, ArrayMaxSize } from 'class-validator';

export class EditReviewDto {

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false, description: 'Replaces the review\'s main comment text' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  @ArrayMaxSize(4)
  media?: string[];

  @ApiProperty({ required: false, enum: ['home', 'classroom', 'school'] })
  @IsOptional()
  @IsIn(['home', 'classroom', 'school'])
  usedFor?: 'home' | 'classroom' | 'school';

}
