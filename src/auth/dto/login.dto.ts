import { IsEmail, IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  /** Staff accounts: 6-digit authenticator code, or a one-time recovery code. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  totp?: string;
}
