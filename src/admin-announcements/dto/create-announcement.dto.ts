/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAnnouncementDto {
  @ApiProperty({ example: 'Platform Maintenance — May 18, 2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @ApiProperty({ example: 'We will be performing scheduled maintenance...' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @ApiProperty({ enum: ['all', 'sellers', 'buyers'], required: false })
  @IsOptional()
  @IsEnum(['all', 'sellers', 'buyers'])
  audience?: string;

  @ApiProperty({ enum: ['draft', 'published', 'scheduled'], required: false })
  @IsOptional()
  @IsEnum(['draft', 'published', 'scheduled'])
  status?: string;

  @ApiProperty({ required: false, example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
