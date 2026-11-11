/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

export class SellerStartConversationDto {
  @ApiProperty({ description: 'The seller\'s own store' })
  @IsMongoId()
  storeId: string;

  @ApiProperty({ description: 'A student (buyer of a digital product) of that store' })
  @IsMongoId()
  buyerId: string;
}
