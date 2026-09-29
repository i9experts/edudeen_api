/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class RunMonthlySettlementDto {
  @ApiProperty({ required: false, example: 'PKR', description: 'Only settle balances in this currency — omit to settle every currency' })
  @IsOptional() @IsString()
  currency?: string;

  @ApiProperty({ required: false, example: '2026-09', description: 'Settlement month label (YYYY-MM) written to each payout note — defaults to the previous UTC month' })
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be in YYYY-MM format' })
  month?: string;
}
