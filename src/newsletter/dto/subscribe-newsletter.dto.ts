import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional } from 'class-validator';

export class SubscribeNewsletterDto {
  @ApiProperty({ example: 'buyer@example.com' })
  @IsEmail()
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  /** Where the sign-up came from (stored on the subscriber): footer / home newsletter / app-launch notify-me. */
  @ApiProperty({ required: false, enum: ['footer', 'home', 'app-notify'] })
  @IsOptional()
  @IsIn(['footer', 'home', 'app-notify'])
  source?: 'footer' | 'home' | 'app-notify';
}
