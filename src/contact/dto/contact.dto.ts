import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ContactSubmissionStatus } from '../schemas/contact-submission.schema';

export class CreateContactSubmissionDto {
  @ApiProperty({ example: 'Jane Cooper' })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail()
  @IsNotEmpty({ message: 'Email is required' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Order or delivery' })
  @IsString()
  @IsNotEmpty({ message: 'Topic is required' })
  @MaxLength(100)
  topic: string;

  @ApiProperty({ example: "Tell us a bit about what's going on…" })
  @IsString()
  @IsNotEmpty({ message: 'Message is required' })
  @MaxLength(5000)
  message: string;
}

export class UpdateContactStatusDto {
  @ApiProperty({ example: 'resolved', enum: ['new', 'read', 'resolved'] })
  @IsIn(['new', 'read', 'resolved'])
  status: ContactSubmissionStatus;
}
