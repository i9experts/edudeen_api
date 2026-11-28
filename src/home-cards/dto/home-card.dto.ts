import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength, ValidateNested, IsInt, Min, ArrayMinSize, IsMongoId, ValidateIf,
} from 'class-validator';
import { IsLinkTarget } from '../../common/link-target.util';
import { HOME_CARD_LAYOUTS, HOME_CARD_STATUSES, HOME_CARD_TINTS, HomeCardLayout, HomeCardStatus, HomeCardTint } from '../schemas/home-card.schema';

const IMG = { require_protocol: true, protocols: ['https'] };
// '' means "no picture" (a tile without one falls back to its category photo), so only check non-empty values.
const hasValue = (_: unknown, v: unknown) => v !== undefined && v !== null && v !== '';

export class HomeCardTileDto {
  @IsOptional() @IsString() @MaxLength(40)
  label?: string;

  @ValidateIf(hasValue) @IsUrl(IMG, { message: 'imageUrl must be an https URL' }) @MaxLength(600)
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

  @ValidateIf(hasValue) @IsUrl(IMG, { message: 'imageUrl must be an https URL' }) @MaxLength(600)
  imageUrl?: string;

  @IsOptional() @IsLinkTarget()
  link?: string;

  @IsOptional() @IsString() @MaxLength(30)
  ctaLabel?: string;

  @IsOptional() @IsIn(HOME_CARD_TINTS as unknown as string[], { message: 'tint must be one of: ' + HOME_CARD_TINTS.join(', ') })
  tint?: HomeCardTint;

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
  @ValidateIf(hasValue) @IsUrl(IMG, { message: 'imageUrl must be an https URL' }) @MaxLength(600)
  imageUrl?: string;

  @IsOptional() @IsString() @MaxLength(500)
  link?: string;

  @IsOptional() @IsString() @MaxLength(30)
  ctaLabel?: string;

  @IsOptional() @IsIn(HOME_CARD_TINTS as unknown as string[], { message: 'tint must be one of: ' + HOME_CARD_TINTS.join(', ') })
  tint?: HomeCardTint;

  @IsOptional() @IsIn(HOME_CARD_STATUSES as unknown as string[])
  status?: HomeCardStatus;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  order?: number;
}

export class ReorderHomeCardsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsMongoId({ each: true })
  ids: string[];
}