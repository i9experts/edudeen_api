/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Admin triage of a messaging-abuse report (user / message / conversation). */
export class AdminUpdateMessagingReportDto {
  @ApiProperty({ enum: ['reviewed', 'resolved'] })
  @IsIn(['reviewed', 'resolved'])
  status: 'reviewed' | 'resolved';

  @ApiProperty({ required: false, example: 'Warned the seller; no further action.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNotes?: string;
}
