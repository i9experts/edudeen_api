/* eslint-disable prettier/prettier */
import { IsString, IsOptional, IsIn, IsNotEmpty, MaxLength } from 'class-validator';
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
  profileImage?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fcmToken?: string;

  // This is the DTO actually wired to PATCH /api/auth/edit-profile — the
  // route the frontend calls for profile updates (see
  // AuthController.editProfile) — NOT UsersController's separate
  // PUT /api/users/profile, which exists but isn't the one the app uses.
  @ApiProperty({ required: false, example: 'PKR', enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currencyPreference?: string;

}
