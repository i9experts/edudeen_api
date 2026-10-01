/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const TRANSACTION_TYPES = ['sale', 'payout', 'fee', 'refund', 'adjustment'] as const;
export const TRANSACTION_STATUSES = ['completed', 'pending', 'failed'] as const;
export const TRANSACTION_PAYMENT_METHOD_TYPES = ['stripe', 'cash_on_delivery', 'manual_bank_transfer', 'free'] as const;

export class AdminTransactionsQueryDto {
  @ApiProperty({ required: false, enum: TRANSACTION_TYPES })
  @IsOptional()
  @IsIn(TRANSACTION_TYPES)
  type?: string;

  @ApiProperty({ required: false, enum: TRANSACTION_STATUSES })
  @IsOptional()
  @IsIn(TRANSACTION_STATUSES)
  status?: string;

  @ApiProperty({ required: false, enum: TRANSACTION_PAYMENT_METHOD_TYPES, description: "Filters by the underlying order's payment method" })
  @IsOptional()
  @IsIn(TRANSACTION_PAYMENT_METHOD_TYPES)
  paymentMethodType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  sellerId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
