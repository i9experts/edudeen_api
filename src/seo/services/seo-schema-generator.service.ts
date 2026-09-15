/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';

const PLATFORM_ORIGIN = 'https://edudeen.com';

/**
 * Pure, stateless JSON-LD builder — no DB access, no caching, just data-in/
 * data-out. Used by `SeoResolutionService` (meta-delivery pipeline) AND
 * directly by the seller schema-preview endpoint (Phase 7), so it's kept as
 * its own injectable rather than folded into `SeoResolutionService` — two
 * different callers need it, one of which (preview) doesn't want the
 * resolution/caching machinery at all.
 */
@Injectable()
export class SeoSchemaGeneratorService {
  buildProductSchema(input: {
    productId: string;
    name: string;
    description: string;
    images: string[];
    slug: string;
    price?: number | null;
    currency?: string;
    availability?: 'InStock' | 'OutOfStock';
    storeName?: string;
    averageRating?: number;
    ratingCount?: number;
  }): Record<string, any> {
    const schema: Record<string, any> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': `${PLATFORM_ORIGIN}/product/${input.slug}`,
      name: input.name,
      description: input.description,
      image: input.images,
    };
    if (input.price != null) {
      schema.offers = {
        '@type': 'Offer',
        price: input.price,
        priceCurrency: input.currency ?? 'USD',
        availability: `https://schema.org/${input.availability ?? 'InStock'}`,
        url: `${PLATFORM_ORIGIN}/product/${input.slug}`,
      };
    }
    if (input.storeName) {
      schema.brand = { '@type': 'Brand', name: input.storeName };
    }
    if (input.ratingCount && input.ratingCount > 0) {
      schema.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: input.averageRating ?? 0,
        reviewCount: input.ratingCount,
      };
    }
    return schema;
  }

  buildStoreSchema(input: { storeId: string; name: string; slug: string; description?: string | null; logo?: string | null }): Record<string, any> {
    return {
      '@context': 'https://schema.org',
      '@type': 'Store',
      '@id': `${PLATFORM_ORIGIN}/${input.slug}`,
      name: input.name,
      description: input.description ?? undefined,
      logo: input.logo ?? undefined,
      url: `${PLATFORM_ORIGIN}/${input.slug}`,
    };
  }

  buildOrganizationSchema(overrides?: Record<string, any> | null): Record<string, any> {
    return overrides ?? {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Edudeen',
      url: PLATFORM_ORIGIN,
    };
  }

  buildWebsiteSchema(overrides?: Record<string, any> | null): Record<string, any> {
    return overrides ?? {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Edudeen',
      url: PLATFORM_ORIGIN,
    };
  }

  buildSearchActionSchema(overrides?: Record<string, any> | null): Record<string, any> {
    return overrides ?? {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      url: PLATFORM_ORIGIN,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${PLATFORM_ORIGIN}/marketplace?search={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    };
  }

  buildBreadcrumbSchema(items: Array<{ name: string; url: string }>): Record<string, any> {
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: item.url,
      })),
    };
  }
}
