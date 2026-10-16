import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetTestDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isTest: boolean;
}
