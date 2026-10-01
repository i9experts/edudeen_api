/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, IsArray, IsOptional, MaxLength, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class TierDto {
  @ApiProperty({ example: 'Gold' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(0)
  minPoints: number;

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  benefits?: string[];
}

export class UpdateTiersDto {
  @ApiProperty({ type: [TierDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers: TierDto[];
}
