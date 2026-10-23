import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectPayoutDto {
  @ApiProperty({ example: 'Bank details could not be verified' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}