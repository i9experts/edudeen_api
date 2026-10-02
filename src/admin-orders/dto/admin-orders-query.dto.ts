/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AdminOrdersQueryDto {
  @ApiProperty({ required: false, description: 'Order number, order id, or buyer name / email / phone' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiProperty({ required: false, enum: ['pending', 'processing', 'partially_shipped', 'completed', 'cancelled'] })
  @IsOptional()
  @IsIn(['pending', 'processing', 'partially_shipped', 'completed', 'cancelled'])
  status?: string;

  @ApiProperty({ required: false, enum: ['unpaid', 'pending_verification', 'paid', 'failed', 'refunded'] })
  @IsOptional()
  @IsIn(['unpaid', 'pending_verification', 'paid', 'failed', 'refunded'])
  paymentStatus?: string;

  @ApiProperty({ required: false, enum: ['cash_on_delivery', 'stripe', 'manual_bank_transfer'] })
  @IsOptional()
  @IsIn(['cash_on_delivery', 'stripe', 'manual_bank_transfer'])
  paymentType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsMongoId()
  storeId?: string;

  @ApiProperty({ required: false, example: '2026-10-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiProperty({ required: false, example: '2026-10-31' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
