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

export class ApproveListingDto {
  @ApiProperty({ required: false, description: 'Optional note shown to the seller' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
