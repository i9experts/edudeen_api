import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { AttributeValueType } from '../schemas/attribute-definition.schema';

export class CreateAttributeDefinitionDto {
  // lowercase/underscore machine key, e.g. "subject", "resource_type"
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'key must be lowercase letters, numbers and underscores only, starting with a letter',
  })
  key: string;

  @IsString()
  @MaxLength(80)
  label: string;

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
}
