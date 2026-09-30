import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';

export class AdminUsersQueryDto {
  @ApiProperty({ enum: ['buyer', 'seller'], required: false })
  @IsOptional()
  @IsIn(['buyer', 'seller'])
  role?: 'buyer' | 'seller';

  @ApiProperty({ enum: ['active', 'suspended', 'pending'], required: false })
  @IsOptional()
  @IsIn(['active', 'suspended', 'pending'])
  status?: string;

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
