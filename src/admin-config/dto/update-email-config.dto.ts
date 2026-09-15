import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

export class UpdateEmailConfigDto {
  @ApiProperty({ required: false, example: 'Edudeen' })
  @IsOptional()
  @IsString()
  fromName?: string;

  @ApiProperty({ required: false, example: 'noreply@edudeen.com' })
  @IsOptional()
  @IsEmail()
  fromEmail?: string;

  @ApiProperty({ required: false, example: 'support@edudeen.com' })
  @IsOptional()
  @IsEmail()
  replyToEmail?: string;

  @ApiProperty({ required: false, example: 'SendGrid' })
  @IsOptional()
  @IsString()
  provider?: string;
}
