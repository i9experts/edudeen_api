/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, IsIn, Length, IsNumber, IsBoolean, MaxLength } from 'class-validator';
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

  @IsOptional() @IsNumber() priceMin?: number | null;
  @IsOptional() @IsNumber() priceMax?: number | null;
  @IsOptional() @IsNumber() createdWithinDays?: number | null;
  @IsOptional() @IsNumber() minRating?: number | null;
  @IsOptional() @IsBoolean() hasDiscount?: boolean;
  @IsOptional() @IsNumber() bestSellersTopN?: number | null;
  @IsOptional() @IsString() language?: string | null;
  @IsOptional() @IsString() classFrom?: string | null;
  @IsOptional() @IsString() classTo?: string | null;
}

export class UpdateCollectionDto {
  @IsOptional() @IsString() sortBy?: string | null;
  @IsOptional() @IsString() startAt?: string | null;
  @IsOptional() @IsString() endAt?: string | null;
  @IsOptional() @IsString() @MaxLength(100) nameUr?: string | null;
  @IsOptional() @IsString() @MaxLength(500) descriptionUr?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => cleanCollectionName(value))
  @IsString()
  @Length(COLLECTION_NAME_MIN, COLLECTION_NAME_MAX, { message: `Name must be ${COLLECTION_NAME_MIN}-${COLLECTION_NAME_MAX} characters` })
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({ required: false, enum: ['manual', 'automatic'] })
  @IsOptional()
  @IsEnum(['manual', 'automatic'])
  type?: 'manual' | 'automatic';

  @ApiProperty({ required: false, type: CollectionRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionRulesDto)
  rules?: CollectionRulesDto;

  @ApiProperty({ required: false, enum: ['active', 'draft'] })
  @IsOptional()
  @IsIn(['active', 'draft'])
  status?: 'active' | 'draft';
}
