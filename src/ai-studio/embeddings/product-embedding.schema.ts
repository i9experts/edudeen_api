/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductEmbeddingDocument = ProductEmbedding & Document;

/**
 * One embedding vector per product, kept in its OWN collection (not on the product document) so a vector can never leak
 * into a public/admin product response, aggregate or export. Only the semantic-search services read it.
 */
@Schema({ timestamps: true, collection: 'product_embeddings' })
export class ProductEmbedding {
  @Prop({ type: String, required: true, unique: true })
  productId: string;

  @Prop({ type: String, default: null, index: true })
  storeId: string | null;

  /** Provider model that produced the vector (a model change re-embeds everything). */
  @Prop({ type: String, required: true })
  embeddingModel: string;

  /** sha256(model + embedded text): the product is only re-embedded when this changes. */
  @Prop({ type: String, required: true })
  textHash: string;

  @Prop({ type: [Number], required: true })
  vector: number[];
}

export const ProductEmbeddingSchema = SchemaFactory.createForClass(ProductEmbedding);
