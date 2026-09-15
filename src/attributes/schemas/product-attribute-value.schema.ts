/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductAttributeValueDocument = ProductAttributeValue & Document;

// One row per (product, attribute definition) — a product with 4 classified
// attributes has 4 of these rows. `key` is denormalized from the parent
// AttributeDefinition at write time so buyer-filter queries can match by the
// stable key directly, without a join back to the definition on every read.
@Schema({ timestamps: true })
export class ProductAttributeValue {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  attributeDefinitionId: string;

  @Prop({ type: String, required: true })
  key: string;

  // Always an array — a `text`/`select` attribute stores exactly one entry,
  // `multiselect` stores several. Keeping one shape avoids a type-switch at
  // every read/filter site.
  @Prop({ type: [String], required: true })
  values: string[];
}

export const ProductAttributeValueSchema = SchemaFactory.createForClass(
  ProductAttributeValue,
);

ProductAttributeValueSchema.index(
  { productId: 1, attributeDefinitionId: 1 },
  { unique: true },
);
ProductAttributeValueSchema.index({ productId: 1 });
ProductAttributeValueSchema.index({ key: 1, values: 1 });
