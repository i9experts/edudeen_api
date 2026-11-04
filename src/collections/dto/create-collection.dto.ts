/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsArray, ValidateNested, IsIn, Length } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { cleanCollectionName, COLLECTION_NAME_MIN, COLLECTION_NAME_MAX } from '../collection-name.util';

class CollectionRulesDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false, enum: ['all', 'any'] })
  @IsOptional()
  @IsIn(['all', 'any'])
  matchType?: 'all' | 'any';
}

export class CreateCollectionDto {
  @ApiProperty({ example: 'New Arrivals' })
  @Transform(({ value }) => cleanCollectionName(value))
  @IsString()
  @IsNotEmpty()
  @Length(COLLECTION_NAME_MIN, COLLECTION_NAME_MAX, { message: `Name must be ${COLLECTION_NAME_MIN}-${COLLECTION_NAME_MAX} characters` })
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({ enum: ['manual', 'automatic'] })
  @IsEnum(['manual', 'automatic'])
  type: 'manual' | 'automatic';

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  @ApiProperty({ required: false, type: CollectionRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionRulesDto)
  rules?: CollectionRulesDto;
}
