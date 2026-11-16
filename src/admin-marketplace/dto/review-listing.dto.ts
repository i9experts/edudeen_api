/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RejectListingDto {
  @ApiProperty({ example: 'Please add a clear cover image and the grade level.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason: string;
}

/** Admin asks the seller to fix a listing flagged 'needs_review': the note is required (it is sent to the seller). */
export class AskFixDto {
  @ApiProperty({ example: 'The title says Class 5 but the suitable classes are 7-8. Please check one of them.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note: string;
}

export class ApproveListingDto {
  @ApiProperty({ required: false, description: 'Optional note shown to the seller' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
