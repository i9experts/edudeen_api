/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsNumber, IsString, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class RefundInvoiceDto {
  @ApiProperty({ required: false, description: 'Omit to refund the full remaining refundable amount' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01)
  amountUSD?: number;

  @ApiProperty({ required: false, maxLength: 300 })
  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;
}
