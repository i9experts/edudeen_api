/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsMongoId } from 'class-validator';

export class ReorderCollectionsDto {
  @ApiProperty({ type: [String], description: 'Collection ids in the new display order' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsMongoId({ each: true })
  ids: string[];
}
