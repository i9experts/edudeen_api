/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { SeoMeta, SeoMetaSchema } from '../../seo/schemas/seo-meta.schema';

export type CollectionDocument = Collection & Document;

/**
 * A named, curated, per-store product grouping — the primitive the app had
 * nothing for before this (only a single flat `Store.pinnedProductIds`
 * list, which can't represent "New Arrivals" and "Sale" existing at once).
 * Two real types, matching how a serious commerce platform's own collections
 * work: `manual` (seller hand-picks and orders exact products, like
 * `pinnedProductIds` but named/repeatable) and `automatic` (a rule — category
 * and/or tag match — resolved fresh at read time, never stored per-product,
 * so it never goes stale as the catalog changes).
 */
@Schema({ timestamps: true })
export class Collection {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true, trim: true })
  name: string;

  // lowercase letters+digits only (collection-name.util). Duplicate check key, enforced in CollectionsService.
  // TODO(after cleanup, see docs): unique partial index { storeId, normalizedName } - NOT created yet on purpose.
  @Prop({ type: String, default: null })
  normalizedName: string | null;

  // Unique per store (not globally) — see CollectionsService's own slug
  // generator, scoped by storeId unlike the shared generateUniqueSlug()
  // helper (which checks uniqueness globally, right for Store/Category but
  // wrong for a per-store child entity like this one).
  @Prop({ required: true, trim: true, lowercase: true })
  slug: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, enum: ['manual', 'automatic'], default: 'manual' })
  type: 'manual' | 'automatic';

  // Only meaningful when type === 'manual' — ordered, like pinnedProductIds.
  @Prop({ type: [String], default: [] })
  productIds: string[];

  // Only meaningful when type === 'automatic' — resolved at read time by
  // CollectionsService.resolveProducts, never persisted per-product.
  @Prop({
    type: {
      categoryId: { type: String, default: null },
      tags: { type: [String], default: [] },
      matchType: { type: String, enum: ['all', 'any'], default: 'any' },
    },
    default: () => ({ categoryId: null, tags: [], matchType: 'any' }),
  })
  rules: { categoryId: string | null; tags: string[]; matchType: 'all' | 'any' };

  @Prop({ type: String, enum: ['active', 'draft'], default: 'draft' })
  status: 'active' | 'draft';

  @Prop({ type: Number, default: 0 })
  sortOrder: number;

  @Prop({ type: SeoMetaSchema, default: () => ({}) })
  seo: SeoMeta;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const CollectionSchema = SchemaFactory.createForClass(Collection);

CollectionSchema.index({ storeId: 1, slug: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
CollectionSchema.index({ storeId: 1, status: 1 });
