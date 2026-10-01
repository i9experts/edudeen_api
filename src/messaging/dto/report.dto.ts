/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReportDto {
  @ApiProperty({ enum: ['user', 'message', 'conversation'] })
  @IsEnum(['user', 'message', 'conversation'])
  targetType: string;

  @ApiProperty({ example: '665message001' })
  @IsMongoId()
  targetId: string;

  @ApiProperty({ example: 'Spam', enum: ['spam', 'harassment', 'inappropriate_content', 'fraud', 'other'] })
  @IsEnum(['spam', 'harassment', 'inappropriate_content', 'fraud', 'other'])
  reason: string;

  @ApiProperty({ required: false, example: 'This seller keeps sending irrelevant offers' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;
}
