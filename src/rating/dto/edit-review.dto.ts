/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min, Max, IsOptional, IsArray, IsIn } from 'class-validator';

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
  comment?: string;

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
