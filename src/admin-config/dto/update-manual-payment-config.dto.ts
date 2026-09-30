/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Min, MaxLength, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateManualPaymentConfigDto {
  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiProperty({ required: false, example: 'Meezan Bank' })
  @IsOptional() @IsString() @MaxLength(100) bankName?: string;

  @ApiProperty({ required: false, example: 'Edudeen Marketplace Pvt Ltd' })
  @IsOptional() @IsString() @MaxLength(120) accountTitle?: string;

  @ApiProperty({ required: false, example: '01234567890123' })
  @IsOptional() @IsString() @MaxLength(40) accountNumber?: string;

  @ApiProperty({ required: false, example: 'PK00MEZN0001234567890123' })
  @IsOptional() @IsString() @MaxLength(40) iban?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(30) jazzcashNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(30) easypaisaNumber?: string;

  @ApiProperty({ required: false, example: 'Transfer the exact amount shown and upload your receipt.' })
  @IsOptional() @IsString() @MaxLength(1000) instructions?: string;

  @ApiProperty({ required: false, example: 278, description: 'PKR per 1 USD, applied at order-placement time' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(100000) usdToPkrRate?: number;
}
