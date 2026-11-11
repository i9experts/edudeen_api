/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsOptional } from 'class-validator';

export class StartConversationDto {
  @ApiProperty({ example: '665store001', description: 'Store to open a conversation with' })
  @IsMongoId()
  storeId: string;

  @ApiProperty({ required: false, description: 'Product page the buyer is asking from (context only)' })
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @ApiProperty({ required: false, description: 'Order the buyer is asking about (context only)' })
  @IsOptional()
  @IsMongoId()
  orderId?: string;
}
