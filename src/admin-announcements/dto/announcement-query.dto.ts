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

export class AnnouncementQueryDto {
  @ApiProperty({ enum: ['draft', 'published', 'scheduled'], required: false })
  @IsOptional()
  @IsEnum(['draft', 'published', 'scheduled'])
  status?: string;

  @ApiProperty({ enum: ['all', 'sellers', 'buyers'], required: false })
  @IsOptional()
  @IsEnum(['all', 'sellers', 'buyers'])
  audience?: string;

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
