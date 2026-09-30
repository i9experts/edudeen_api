import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RegisterDeviceTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  fcmToken: string;

  @IsEnum(['android', 'ios', 'web'])
  platform: string;
}
