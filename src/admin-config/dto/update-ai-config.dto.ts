import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
  Matches,
} from 'class-validator';

export class UpdateAiConfigDto {
  @ApiProperty({ required: false, example: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000000)
  monthlyCreditLimit?: number;

  @ApiProperty({ required: false, example: 'claude-sonnet-5' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,80}$/, {
    message: 'aiModel must be a plain model id',
  })
  aiModel?: string;
}
