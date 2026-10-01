/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

export class StartConversationDto {
  @ApiProperty({ example: '665store001', description: 'Store to open a conversation with' })
  @IsMongoId()
  storeId: string;
}
