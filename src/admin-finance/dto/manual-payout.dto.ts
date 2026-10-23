/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ManualPayoutDto {
  @ApiProperty({ example: 250.00, description: 'Amount to pay out — must not exceed the seller\'s available balance in the chosen currency' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(10_000_000)
  amount: number;

  @ApiProperty({ required: false, enum: ['USD', 'PKR'], description: 'Currency of the balance to debit. Defaults to the payout method currency, else the store currency, else USD. Must match the payout method when one is given.' })
  @IsOptional()
  @IsIn(['USD', 'PKR'])
  currency?: string;

  @ApiProperty({ required: false, description: 'Existing PayoutMethod _id — omit for an off-platform manual payout (e.g. a wire transfer arranged outside the app)' })
  @IsOptional()
  @IsMongoId()
  payoutMethodId?: string;

  @ApiProperty({ required: false, example: 'Manual correction for missed automatic payout' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}