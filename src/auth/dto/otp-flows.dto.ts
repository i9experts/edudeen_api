import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsString, Length, MaxLength } from 'class-validator';

/**
 * These four endpoints used to read `email` / `role` straight off an untyped body, so a JSON body like
 * `{"email":{"$ne":null}}` reached `userModel.findOne({ email })` as an operator and matched the FIRST account.
 * Typed DTOs make every field a plain string (and the email a real address).
 */
export class ResendOtpDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: ['user', 'seller'] })
  @IsIn(['user', 'seller'])
  role: string;
}

export class VerifyOtpBodyDto extends ResendOtpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp: string;
}

export class ForgotPasswordBodyDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: ['user', 'seller', 'admin'] })
  @IsIn(['user', 'seller', 'admin'])
  role: string;
}

export class ResetPasswordBodyDto extends ForgotPasswordBodyDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp: string;

  @ApiProperty({ minLength: 8, maxLength: 72 })
  @IsString()
  @MaxLength(72)
  newPassword: string;
}
