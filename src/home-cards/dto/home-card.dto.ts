import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength, ValidateNested, IsInt, Min, ArrayMinSize, IsMongoId,
} from 'class-validator';
import { IsLinkTarget } from '../../common/link-target.util';
import { HOME_CARD_LAYOUTS, HOME_CARD_STATUSES, HomeCardLayout, HomeCardStatus } from '../schemas/home-card.schema';

const IMG = { require_protocol: true, protocols: ['https'] };

export class HomeCardTileDto {
  @IsOptional() @IsString() @MaxLength(40)
  label?: string;

  @IsOptional() @IsUrl(IMG, { message: 'imageUrl must be an https URL' }) @MaxLength(600)
  imageUrl?: string;

  @IsOptional() @IsLinkTarget()
  link?: string;
}

export class CreateHomeCardDto {
  @IsString() @IsNotEmpty() @MaxLength(60)
  title: string;

  @IsOptional() @IsIn(HOME_CARD_LAYOUTS as unknown as string[])
  layout?: HomeCardLayout;

  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => HomeCardTileDto)
  tiles?: HomeCardTileDto[];

  @IsOptional() @IsUrl(IMG, { message: 'imageUrl must be an https URL' }) @MaxLength(600)
  imageUrl?: string;

  @IsOptional() @IsLinkTarget()
  link?: string;

  @IsOptional() @IsString() @MaxLength(30)
  ctaLabel?: string;

  @IsOptional() @IsIn(HOME_CARD_STATUSES as unknown as string[])
  status?: HomeCardStatus;
}

export class UpdateHomeCardDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  title?: string;

  @IsOptional() @IsIn(HOME_CARD_LAYOUTS as unknown as string[])
  layout?: HomeCardLayout;

  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => HomeCardTileDto)
  tiles?: HomeCardTileDto[];

  // '' clears the image.
  @IsOptional() @IsString() @MaxLength(600)
  imageUrl?: string;

  @IsOptional() @IsString() @MaxLength(500)
  link?: string;

  @IsOptional() @IsString() @MaxLength(30)
  ctaLabel?: string;

  @IsOptional() @IsIn(HOME_CARD_STATUSES as unknown as string[])
  status?: HomeCardStatus;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  order?: number;
}

export class ReorderHomeCardsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsMongoId({ each: true })
  ids: string[];
}