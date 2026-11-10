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
      // Smart rules (all optional, ANDed with the above). Missing on old docs = no such rule.
      priceMin: { type: Number, default: null },
      priceMax: { type: Number, default: null },
      createdWithinDays: { type: Number, default: null },
      minRating: { type: Number, default: null },
      hasDiscount: { type: Boolean, default: false },
      bestSellersTopN: { type: Number, default: null },
      language: { type: String, default: null },
      classFrom: { type: String, default: null },
      classTo: { type: String, default: null },
    },
    default: () => ({ categoryId: null, tags: [], matchType: 'any' }),
  })
  rules: {
    categoryId: string | null; tags: string[]; matchType: 'all' | 'any';
    priceMin?: number | null; priceMax?: number | null; createdWithinDays?: number | null; minRating?: number | null;
    hasDiscount?: boolean; bestSellersTopN?: number | null; language?: string | null; classFrom?: string | null; classTo?: string | null;
  };

  // How products are ordered inside the collection. null/'manual' = old behaviour (seller order / newest).
  @Prop({ type: String, default: null })
  sortBy: string | null;

  // Optional schedule: outside [startAt, endAt) the collection is hidden from the public store.
  @Prop({ type: Date, default: null })
  startAt: Date | null;

  @Prop({ type: Date, default: null })
  endAt: Date | null;

  // Optional Urdu text, shown in buyer Urdu mode only.
  @Prop({ type: String, default: null })
  nameUr: string | null;

  @Prop({ type: String, default: null })
  descriptionUr: string | null;

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
