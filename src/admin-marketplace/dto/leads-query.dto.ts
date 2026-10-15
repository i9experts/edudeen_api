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

export class LeadsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({
    required: false,
    enum: ['pending', 'active', 'rejected', 'suspended', 'all'],
    description:
      'Store status. Omit for pending; "all" removes the filter.',
  })
  @IsOptional()
  @IsIn(['pending', 'active', 'rejected', 'suspended', 'all'])
  status?: string;

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
