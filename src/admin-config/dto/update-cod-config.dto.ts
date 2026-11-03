/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateCodConfigDto {
  @ApiProperty({ required: false, nullable: true, description: 'Max COD amount per package in PKR. null = no limit.' })
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @Type(() => Number) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(1) @Max(100_000_000)
  maxPerPackagePKR?: number | null;

  @ApiProperty({ required: false, description: 'COD fee added to each physical package in PKR. 0 = none.' })
  @IsOptional() @Type(() => Number) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100_000)
  feePerPackagePKR?: number;
}
