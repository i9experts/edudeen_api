import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, MaxLength, IsIn } from 'class-validator';
import { SUPPORTED_CURRENCIES } from 'src/exchange-rate/schemas/exchange-rate.schema';

export class UpdateProfileDto {
  @ApiProperty({ required: false, example: 'Jami Raza' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({ required: false, example: 'jami@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: '+1234567890' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false, example: 'karachi, pakistan' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false, example: 'https://example.com/profile.jpg' })
  @IsOptional()
  @IsString()
  profileImage?: string;

  // Explicit buyer currency choice — once set, this is the source of truth
  // for checkout/display currency and wins over any location-based default
  // or guest cookie (see CheckoutService). Folded into the existing profile
  // endpoint rather than a dedicated route, matching this codebase's
  // existing API surface instead of adding a sibling endpoint for one field.
  @ApiProperty({ required: false, example: 'PKR', enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currencyPreference?: string;
}
