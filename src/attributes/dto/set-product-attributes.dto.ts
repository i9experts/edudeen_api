import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ProductAttributeValueInput {
  @IsString()
  attributeDefinitionId: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  values: string[];
}

export class SetProductAttributesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeValueInput)
  attributes: ProductAttributeValueInput[];
}
