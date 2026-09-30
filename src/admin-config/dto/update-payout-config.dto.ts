/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, IsOptional, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePayoutConfigDto {
  @ApiProperty({ required: false, example: 5 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1000000) minPayoutUSD?: number;

  @ApiProperty({ required: false, example: 1500 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100000000) minPayoutPKR?: number;
}
