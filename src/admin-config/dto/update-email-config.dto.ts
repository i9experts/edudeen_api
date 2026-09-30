import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';

export class UpdateEmailConfigDto {
  @ApiProperty({ required: false, example: 'Edudeen' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[^\r\n<>]*$/, {
    message: 'fromName must not contain line breaks or angle brackets',
  })
  fromName?: string;

  @ApiProperty({ required: false, example: 'noreply@edudeen.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  fromEmail?: string;

  @ApiProperty({ required: false, example: 'support@edudeen.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  replyToEmail?: string;

  @ApiProperty({ required: false, example: 'SendGrid' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string;
}
