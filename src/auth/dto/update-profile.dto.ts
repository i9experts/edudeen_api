/* eslint-disable prettier/prettier */
import { IsString, IsOptional, IsIn, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SUPPORTED_CURRENCIES } from 'src/exchange-rate/schemas/exchange-rate.schema';

export class AuthUpdateProfileDto {

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Name cannot be empty' })
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^https:\/\//i, { message: 'profileImage must be an https URL' })
  profileImage?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  fcmToken?: string;

  // This is the DTO actually wired to PATCH /api/auth/edit-profile — the
  // route the frontend calls for profile updates (see
  // AuthController.editProfile) — NOT UsersController's separate
  // PUT /api/users/profile, which exists but isn't the one the app uses.
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
