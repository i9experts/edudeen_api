/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsOptional, IsBoolean, Length } from 'class-validator';

export class AddPayoutMethodDto {
  @ApiProperty({ enum: ['bank_transfer', 'jazzcash', 'easypaisa', 'paypal', 'stripe'] })
  @IsEnum(['bank_transfer', 'jazzcash', 'easypaisa', 'paypal', 'stripe'])
  type: string;

  @ApiProperty({ required: false, enum: ['USD', 'PKR'], description: 'Defaults to PKR for jazzcash/easypaisa, USD otherwise' })
  @IsOptional() @IsEnum(['USD', 'PKR']) currency?: string;

  // Bank transfer fields
  @ApiProperty({ required: false, example: 'Chase Bank' })
  @IsOptional() @IsString() bankName?: string;

  @ApiProperty({ required: false, example: 'John Doe' })
  @IsOptional() @IsString() accountHolder?: string;

  @ApiProperty({ required: false, example: '123456789', description: 'Full account number — only last 4 digits are stored' })
  // Upper bound 34 = max IBAN length — Pakistani sellers commonly enter their
  // 24-char IBAN here, which a 20-char cap would wrongly reject.
  @IsOptional() @IsString() @Length(4, 34) accountNumber?: string;

  @ApiProperty({ required: false, example: '021000021' })
  @IsOptional() @IsString() routingNumber?: string;

  // Stripe / PayPal
  @ApiProperty({ required: false, example: 'seller@paypal.com or acct_stripe_id' })
  @IsOptional() @IsString() @IsNotEmpty() externalAccountId?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional() @IsBoolean() setAsDefault?: boolean;
}
