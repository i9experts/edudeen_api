/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, IsOptional, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { PAYOUT_FREQUENCIES } from '../schemas/platform-config.schema';

export class UpdatePayoutConfigDto {
  @ApiProperty({ required: false, example: 5 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPayoutUSD?: number;

  @ApiProperty({ required: false, example: 1500 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPayoutPKR?: number;

  @ApiProperty({ required: false, enum: PAYOUT_FREQUENCIES, example: 'monthly', description: 'Frequency new seller payout schedules start on — existing schedules are not changed' })
  @IsOptional() @IsIn(PAYOUT_FREQUENCIES as unknown as string[]) payoutFrequency?: string;
}
