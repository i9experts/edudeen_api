/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAnnouncementDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message?: string;

  @ApiProperty({ enum: ['all', 'sellers', 'buyers'], required: false })
  @IsOptional()
  @IsEnum(['all', 'sellers', 'buyers'])
  audience?: string;

  @ApiProperty({ required: false, example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
