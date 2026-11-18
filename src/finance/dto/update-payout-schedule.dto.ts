/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsNumber, IsBoolean, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePayoutScheduleDto {
  @ApiProperty({ required: false, enum: ['USD', 'PKR'], description: 'Which of the store\'s per-currency schedules this update applies to — defaults to USD' })
  @IsOptional() @IsEnum(['USD', 'PKR'])
  currency?: string;

  @ApiProperty({ required: false, enum: ['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'manual'], description: 'semimonthly = the 1st and 15th of every month (seller choice; existing schedules are never moved automatically)' })
  @IsOptional()
  @IsEnum(['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'manual'])
  frequency?: string;

  @ApiProperty({ required: false, example: 1, description: '0=Sun … 6=Sat — used when frequency is weekly' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(6)
  dayOfWeek?: number;

  @ApiProperty({ required: false, example: 15, description: '1–28 — used when frequency is monthly' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(28)
  dayOfMonth?: number;

  @ApiProperty({ required: false, example: 50, description: 'Minimum available balance to trigger auto payout' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  minimumAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({ required: false, description: 'Set default payout method for automatic payouts' })
  @IsOptional() @IsString()
  defaultPayoutMethodId?: string;
}
