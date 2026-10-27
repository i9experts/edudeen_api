import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, MaxLength, IsIn, Matches } from 'class-validator';
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
  @MaxLength(40)
  phone?: string;

  @ApiProperty({ required: false, example: 'karachi, pakistan' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiProperty({ required: false, example: 'https://example.com/profile.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^https:\/\//i, { message: 'profileImage must be an https URL' })
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

  // Display-only (never charged): any ISO-4217 code, e.g. AED. Charge currency stays currencyPreference.
  @ApiProperty({ required: false, example: 'AED' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'displayCurrency must be a 3-letter currency code' })
  displayCurrency?: string;

  // Country the web detected (CDN header / browser) when the account was created or first signed in.
  @ApiProperty({ required: false, example: 'AE' })
  @IsOptional()
  @Matches(/^[A-Z]{2}$/, { message: 'detectedCountry must be a 2-letter country code' })
  detectedCountry?: string;
}
