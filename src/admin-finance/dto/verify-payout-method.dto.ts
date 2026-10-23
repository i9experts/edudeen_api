/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class VerifyPayoutMethodDto {
  @ApiProperty({ description: 'true to activate the payout method, false to reject it' })
  @IsBoolean()
  approve: boolean;

  @ApiProperty({ required: false, example: 'Account title confirmed to match seller ID' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
