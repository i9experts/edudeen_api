import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Where this store's buyers send bank-transfer / wallet payments. All optional; at least one account is needed to switch it on. */
export class StorePaymentSettingsDto {
  @IsOptional() @IsString() @MaxLength(120) bankName?: string | null;
  @IsOptional() @IsString() @MaxLength(120) accountTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(40) accountNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(40) iban?: string | null;
  @IsOptional() @IsString() @MaxLength(30) jazzcashNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(30) easypaisaNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(500) instructions?: string | null;
}
