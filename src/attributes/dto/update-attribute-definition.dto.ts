import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { AttributeValueType } from '../schemas/attribute-definition.schema';

export class UpdateAttributeDefinitionDto {
  // `key` is intentionally not editable — it's referenced by every existing
  // ProductAttributeValue row and by buyer filter URLs; relabel via `label`.
  @IsString()
  @IsOptional()
  @MaxLength(80)
  label?: string;

  @IsEnum(AttributeValueType)
  @IsOptional()
  type?: AttributeValueType;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  options?: string[];

  @IsBoolean()
  @IsOptional()
  required?: boolean;

  @IsBoolean()
  @IsOptional()
  searchable?: boolean;

  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  isDelete?: boolean;
}
