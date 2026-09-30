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
import { VERIFICATION_STATUSES } from '../../store/schemas/store.schema';

export class LeadsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({
    required: false,
    enum: [...VERIFICATION_STATUSES, 'all'],
    description:
      'Omit for the default pending/under_review review queue; "all" removes the status filter entirely.',
  })
  @IsOptional()
  @IsIn([...VERIFICATION_STATUSES, 'all'])
  verificationStatus?: string;

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
