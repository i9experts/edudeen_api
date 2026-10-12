/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class PlatformFeeRuleDto {
  @ApiProperty({ enum: ['percentage', 'fixed'] })
  @IsIn(['percentage', 'fixed']) mode: 'percentage' | 'fixed';

  @ApiProperty({ description: 'percentage: 0-100 (% of the item price). fixed: USD per unit sold (>= 0).' })
  @Type(() => Number) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1_000_000) value: number;
}

export class UpdatePlatformFeesDto {
  @ApiProperty({ required: false, type: PlatformFeeRuleDto })
  @IsOptional() @ValidateNested() @Type(() => PlatformFeeRuleDto) digital?: PlatformFeeRuleDto;

  @ApiProperty({ required: false, type: PlatformFeeRuleDto })
  @IsOptional() @ValidateNested() @Type(() => PlatformFeeRuleDto) physical?: PlatformFeeRuleDto;
}