/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { RedisService } from 'src/redis/redis.service';
import { PlatformSeoService } from './platform-seo-settings.service';
import { SeoSchemaGeneratorService } from './seo-schema-generator.service';

export type SeoEntityType = 'product' | 'category' | 'store';

export interface ResolvedSeoMeta {
  entityType: SeoEntityType;
  entityId: string;
  url: string;
  title: string;
  description: string;
  canonicalUrl: string;
  noindex: boolean;
  ogTitle: string;
  ogDescription: string;
  ogImage: string | null;
  twitterCard: string;
  jsonLd: Record<string, any>[];
}

const PLATFORM_ORIGIN = 'https://edudeen.com';
const CACHE_TTL_SECONDS = 600; // 10 min — same order of magnitude as analytics-cache.util's convention

/**
 * The meta-delivery engine (see architecture plan Refinement #1). Given
 * `(entityType, entityId)`, walks the fallback chain — entity override →
 * parent (category for products / nothing further for category-store) →
 * global token-templated default — and returns everything a page's `<head>`
 * needs: title, description, canonical, robots, Open Graph, Twitter Card,
 * and JSON-LD. Consumed by `SeoRenderController` (public) and by seller
 * preview endpoints (Phase 7).
 *
 * Redis-cached per entity, invalidated explicitly via `invalidate()` by
 * whatever service writes to that entity's `.seo` field — not on a bare TTL
 * alone, so an edit is reflected immediately rather than up to 10 minutes
 * later.
 */
@Injectable()
export class SeoResolutionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly platformSeoService: PlatformSeoService,
    private readonly schemaGenerator: SeoSchemaGeneratorService,
  ) {}

  async resolve(entityType: SeoEntityType, entityIdOrSlug: string): Promise<ResolvedSeoMeta> {
    const cacheKey = this.cacheKey(entityType, entityIdOrSlug);
    if (this.redis.isConnected) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try { return JSON.parse(cached) as ResolvedSeoMeta; } catch { /* fall through and recompute */ }
      }
    }

    const resolved = await this.compute(entityType, entityIdOrSlug);
    if (this.redis.isConnected) {
      await this.redis.set(cacheKey, JSON.stringify(resolved), CACHE_TTL_SECONDS);
    }
    return resolved;
  }

  /** Called by any service that writes to Product.seo/Category.seo/Store.seo — must be invoked with the real entityId (not a slug), since that's how the cache key is built for writes. */
  async invalidate(entityType: SeoEntityType, entityId: string): Promise<void> {
    await this.redis.del(this.cacheKey(entityType, entityId));
  }

  private cacheKey(entityType: SeoEntityType, entityIdOrSlug: string): string {
    return `seo:meta:${entityType}:${entityIdOrSlug}`;
  }

  private async compute(entityType: SeoEntityType, entityIdOrSlug: string): Promise<ResolvedSeoMeta> {
    if (entityType === 'product') return this.resolveProduct(entityIdOrSlug);
    if (entityType === 'category') return this.resolveCategory(entityIdOrSlug);
    return this.resolveStore(entityIdOrSlug);
  }

  private async resolveProduct(idOrSlug: string): Promise<ResolvedSeoMeta> {
    const { productModel, productVariantModel, categoryModel, storeModel } = this.db.repositories;
    const product = await this.findByIdOrSlug(productModel, idOrSlug);
    if (!product) throw new NotFoundException('Product not found.');

    const [category, store, variants] = await Promise.all([
      product.categoryId ? categoryModel.findById(product.categoryId).lean() : null,
      storeModel.findById(product.storeId).lean(),
      productVariantModel.find({ productId: product._id.toString(), isDelete: false }).lean(),
    ]);
    const defaultVariant = (variants as any[]).find((v) => v.isDefault) ?? (variants as any[])[0] ?? null;

    const settings = await this.platformSeoService.getSettings();
    const template = settings.metaTemplates?.find((t: any) => t.key === 'product');

    const seo = (product).seo ?? {};
    const categorySeo = (category as any)?.seo ?? {};
    const storeSeo = (store as any)?.seo ?? {};
    const storeName = (store as any)?.name ?? '';

    const title = seo.metaTitle
      ?? categorySeo.metaTitle
      ?? storeSeo.metaTitle
      ?? renderTemplate(template?.titleTemplate, { productName: product.name, storeName, categoryName: (category as any)?.name })
      ?? `${product.name} | ${storeName || 'Edudeen'}`;

    const description = seo.metaDescription
      ?? categorySeo.metaDescription
      ?? storeSeo.metaDescription
      ?? renderTemplate(template?.descriptionTemplate, { productName: product.name, storeName })
      ?? truncate(product.description, 160);

    const ogImage = seo.ogImage ?? product.images?.[0] ?? storeSeo.ogImage ?? null;
    const canonicalUrl = seo.canonicalUrlOverride ?? `${PLATFORM_ORIGIN}/product/${product.slug}`;

    const jsonLd = [
      this.schemaGenerator.buildProductSchema({
        productId: product._id.toString(),
        name: product.name,
        description: product.description,
        images: product.images ?? [],
        slug: product.slug,
        price: defaultVariant?.price ?? null,
        availability: defaultVariant?.stock > 0 || product.type === 'digital' ? 'InStock' : 'OutOfStock',
        storeName,
        averageRating: product.averageRating,
        ratingCount: product.ratingSum,
      }),
      this.schemaGenerator.buildBreadcrumbSchema([
        { name: 'Marketplace', url: `${PLATFORM_ORIGIN}/marketplace` },
        ...(category ? [{ name: (category as any).name, url: `${PLATFORM_ORIGIN}/marketplace?category=${(category as any)._id}` }] : []),
        { name: product.name, url: canonicalUrl },
      ]),
    ];

    return {
      entityType: 'product',
      entityId: product._id.toString(),
      url: canonicalUrl,
      title,
      description,
      canonicalUrl,
      noindex: !!seo.noindex,
      ogTitle: seo.ogTitle ?? title,
      ogDescription: seo.ogDescription ?? description,
      ogImage,
      twitterCard: seo.twitterCard ?? 'summary_large_image',
      jsonLd,
    };
  }

  private async resolveCategory(idOrSlug: string): Promise<ResolvedSeoMeta> {
    const { categoryModel } = this.db.repositories;
    const category = await categoryModel.findById(idOrSlug).lean();
    if (!category) throw new NotFoundException('Category not found.');

    const settings = await this.platformSeoService.getSettings();
    const template = settings.metaTemplates?.find((t: any) => t.key === 'category');
    const seo = (category as any).seo ?? {};

    const title = seo.metaTitle
      ?? renderTemplate(template?.titleTemplate, { categoryName: (category as any).name })
      ?? `${(category as any).name} | Edudeen Marketplace`;
    const description = seo.metaDescription
      ?? renderTemplate(template?.descriptionTemplate, { categoryName: (category as any).name })
      ?? `Shop ${(category as any).name} on Edudeen.`;
    const canonicalUrl = seo.canonicalUrlOverride ?? `${PLATFORM_ORIGIN}/marketplace?category=${(category as any)._id}`;

    return {
      entityType: 'category',
      entityId: (category as any)._id.toString(),
      url: canonicalUrl,
      title,
      description,
      canonicalUrl,
      noindex: !!seo.noindex,
      ogTitle: seo.ogTitle ?? title,
      ogDescription: seo.ogDescription ?? description,
      ogImage: seo.ogImage ?? (category as any).image ?? null,
      twitterCard: seo.twitterCard ?? 'summary_large_image',
      jsonLd: [this.schemaGenerator.buildBreadcrumbSchema([
        { name: 'Marketplace', url: `${PLATFORM_ORIGIN}/marketplace` },
        { name: (category as any).name, url: canonicalUrl },
      ])],
    };
  }

  private async resolveStore(idOrSlug: string): Promise<ResolvedSeoMeta> {
    const { storeModel } = this.db.repositories;
    const store = await this.findByIdOrSlug(storeModel, idOrSlug, 'slug');
    if (!store) throw new NotFoundException('Store not found.');

    const settings = await this.platformSeoService.getSettings();
    const template = settings.metaTemplates?.find((t: any) => t.key === 'store');
    const seo = (store).seo ?? {};

    const title = seo.metaTitle
      ?? renderTemplate(template?.titleTemplate, { storeName: store.name })
      ?? `${store.name} | Edudeen`;
    const description = seo.metaDescription
      ?? renderTemplate(template?.descriptionTemplate, { storeName: store.name })
      ?? truncate(store.description ?? `Shop ${store.name} on Edudeen.`, 160);
    const canonicalUrl = seo.canonicalUrlOverride ?? `${PLATFORM_ORIGIN}/${store.slug}`;

    return {
      entityType: 'store',
      entityId: store._id.toString(),
      url: canonicalUrl,
      title,
      description,
      canonicalUrl,
      noindex: !!seo.noindex,
      ogTitle: seo.ogTitle ?? title,
      ogDescription: seo.ogDescription ?? description,
      ogImage: seo.ogImage ?? store.logo ?? null,
      twitterCard: seo.twitterCard ?? 'summary_large_image',
      jsonLd: [this.schemaGenerator.buildStoreSchema({
        storeId: store._id.toString(),
        name: store.name,
        slug: store.slug,
        description: store.description,
        logo: store.logo,
      })],
    };
  }

  /** Products/Stores are addressable by either Mongo _id or their unique slug — tries id first (cheap, indexed), falls back to slug. */
  private async findByIdOrSlug(model: any, idOrSlug: string, slugField = 'slug') {
    if (/^[a-f0-9]{24}$/i.test(idOrSlug)) {
      const byId = await model.findOne({ _id: idOrSlug, isDelete: false }).lean();
      if (byId) return byId;
    }
    return model.findOne({ [slugField]: idOrSlug, isDelete: false }).lean();
  }
}

function renderTemplate(template: string | undefined | null, tokens: Record<string, string | undefined>): string | null {
  if (!template) return null;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => tokens[key] ?? '');
}

function truncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
