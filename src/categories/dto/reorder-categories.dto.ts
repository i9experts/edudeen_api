import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsMongoId, Max, Min, ValidateNested } from 'class-validator';

export class ReorderCategoryItemDto {
  @ApiProperty({ example: '64f0c0ffee0c0ffee0c0ffee' })
  @IsMongoId()
  id: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder: number;
}

export class ReorderCategoriesDto {
  @ApiProperty({ type: [ReorderCategoryItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReorderCategoryItemDto)
  items: ReorderCategoryItemDto[];
}
