import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAINTENANCE_SCOPES, MAINTENANCE_TYPES } from '../maintenance.util';

export class UpdateMaintenanceDto {
  /** Armed on/off. With a future `startsAt` it is "scheduled" (banner now, blocks at the start time). */
  @ApiProperty({ example: true })
  @IsBoolean()
  maintenanceMode: boolean;

  @ApiProperty({ required: false, enum: MAINTENANCE_SCOPES, isArray: true, description: 'What is affected. "all" = the whole platform except admin tools.' })
  @IsOptional() @IsArray() @IsIn(MAINTENANCE_SCOPES, { each: true })
  scopes?: string[];

  @ApiProperty({ required: false, enum: MAINTENANCE_TYPES })
  @IsOptional() @IsIn(MAINTENANCE_TYPES)
  type?: string;

  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) message?: string;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsString() @MaxLength(300) statusNote?: string;
}
