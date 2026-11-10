import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DeleteStoreDto {
  // Mandatory and held to a higher bar than a listing removal (RemoveListingDto's
  // 3 chars) — this takes the whole store and every one of its products down.
  @ApiProperty({ example: 'Repeated counterfeit listings after two prior warnings' })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
