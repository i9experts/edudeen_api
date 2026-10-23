/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class SuspendAccountDto {
  @ApiProperty({ example: 'Repeated policy violations - see report #123', description: 'Why the account is being suspended (kept in the audit log)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}