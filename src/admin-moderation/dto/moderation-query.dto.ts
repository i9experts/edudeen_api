import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';

export class ModerationQueryDto {
  @ApiProperty({ enum: ['listing', 'seller', 'review'], required: false })
  @IsOptional()
  @IsEnum(['listing', 'seller', 'review'])
  targetType?: string;

  @ApiProperty({ enum: ['high', 'medium', 'low'], required: false })
  @IsOptional()
  @IsEnum(['high', 'medium', 'low'])
  riskLevel?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
