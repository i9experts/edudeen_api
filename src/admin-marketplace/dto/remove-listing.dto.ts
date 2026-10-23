/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RemoveListingDto {
  @ApiProperty({ example: 'Copyrighted material', description: 'Why the listing is removed - shown to the seller and kept in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}