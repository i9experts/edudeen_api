/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateManualPaymentConfigDto {
  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiProperty({ required: false, example: 'Meezan Bank' })
  @IsOptional() @IsString() bankName?: string;

  @ApiProperty({ required: false, example: 'Edudeen Marketplace Pvt Ltd' })
  @IsOptional() @IsString() accountTitle?: string;

  @ApiProperty({ required: false, example: '01234567890123' })
  @IsOptional() @IsString() accountNumber?: string;

  @ApiProperty({ required: false, example: 'PK00MEZN0001234567890123' })
  @IsOptional() @IsString() iban?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() jazzcashNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() easypaisaNumber?: string;

  @ApiProperty({ required: false, example: 'Transfer the exact amount shown and upload your receipt.' })
  @IsOptional() @IsString() instructions?: string;

  @ApiProperty({ required: false, example: 278, description: 'PKR per 1 USD, applied at order-placement time' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) usdToPkrRate?: number;
}
