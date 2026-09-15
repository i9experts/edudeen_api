/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AttributeDefinitionDocument = AttributeDefinition & Document;

export enum AttributeValueType {
  TEXT = 'text',
  SELECT = 'select',
  MULTISELECT = 'multiselect',
}

// A category-scoped classification field (e.g. Subject, Resource Type, Format,
// Language for an educational category; Material, Colour for a physical one).
// Selecting a category in the seller product form determines which of these
// show up — one mechanism serving both the TPT taxonomy need (subject/grade/
// resource-type/format) and the Etsy "structured attributes vs free tags" need.
@Schema({ timestamps: true })
export class AttributeDefinition {
  @Prop({ type: String, required: true })
  categoryId: string;

  // Stable machine key used in ProductAttributeValue.key and in buyer filter
  // query params — never changes even if `label` is edited/relabelled.
  @Prop({ type: String, required: true })
  key: string;

  @Prop({ type: String, required: true })
  label: string;

  @Prop({
    type: String,
    enum: Object.values(AttributeValueType),
    default: AttributeValueType.SELECT,
  })
  type: AttributeValueType;

  // Only meaningful for select/multiselect — the fixed choice list a seller
  // picks from. Ignored for `text`.
  @Prop({ type: [String], default: [] })
  options: string[];

  @Prop({ default: false })
  required: boolean;

  // Whether this attribute is exposed as a buyer-facing filter/facet, vs.
  // classification-only metadata that never appears in the filter rail.
  @Prop({ default: true })
  searchable: boolean;

  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: false })
  isDelete: boolean;
}

export const AttributeDefinitionSchema =
  SchemaFactory.createForClass(AttributeDefinition);

// One key per category — the same key (e.g. "subject") means the same thing
// everywhere it's reused, so definitions aren't accidentally duplicated.
AttributeDefinitionSchema.index(
  { categoryId: 1, key: 1 },
  { unique: true },
);
AttributeDefinitionSchema.index({ categoryId: 1, sortOrder: 1 });
