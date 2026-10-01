import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class BlockDto {
  @ApiProperty({ example: '665user001' })
  @IsMongoId()
  targetId: string;

  @ApiProperty({ enum: ['user', 'seller'] })
  @IsEnum(['user', 'seller'])
  targetRole: string;

  @ApiProperty({ required: false, example: 'Spam messages' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
