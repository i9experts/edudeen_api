/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class CreateOnboardingLinkDto {
  @ApiProperty({ example: 'https://edudeen.com/seller/store/123/settings' })
  @IsString()
  @IsNotEmpty()
  refreshUrl: string;

  @ApiProperty({ example: 'https://edudeen.com/seller/store/123/settings?connect=done' })
  @IsString()
  @IsNotEmpty()
  returnUrl: string;
}
