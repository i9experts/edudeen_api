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
    /** Optional book details; Book fields are added only for the ones that exist. */
    book?: { author?: string | null; publisher?: string | null; edition?: string | null; pages?: number | null; isbn?: string | null; binding?: string | null; language?: string | null };
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
        ...(input.storeName ? { seller: { '@type': 'Organization', name: input.storeName } } : {}),
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
    // Book fields only when the seller filled them in; a product with none stays a plain Product.
    const b = input.book;
    if (b) {
      const bookFields: Record<string, any> = {};
      if (b.author?.trim()) bookFields.author = { '@type': 'Person', name: b.author.trim() };
      if (b.publisher?.trim()) bookFields.publisher = { '@type': 'Organization', name: b.publisher.trim() };
      if (b.edition?.trim()) bookFields.bookEdition = b.edition.trim();
      if (b.pages) bookFields.numberOfPages = b.pages;
      if (b.isbn) bookFields.isbn = b.isbn;
      const fmt = ({ paperback: 'Paperback', hardcover: 'Hardcover' } as Record<string, string>)[b.binding ?? ''];
      if (fmt) bookFields.bookFormat = `https://schema.org/${fmt}`;
      const lang = ({ ur: 'ur', en: 'en', ar: 'ar' } as Record<string, string>)[b.language ?? ''];
      if (lang) bookFields.inLanguage = lang;
      if (Object.keys(bookFields).length) {
        schema['@type'] = ['Product', 'Book'];
        Object.assign(schema, bookFields);
      }
    }
    return schema;
  }

  buildStoreSchema(input: { storeId: string; name: string; slug: string; description?: string | null; logo?: string | null }): Record<string, any> {
    return {
      '@context': 'https://schema.org',
      '@type': 'Store',
      '@id': `${PLATFORM_ORIGIN}/shop/${input.slug}`,
      name: input.name,
      description: input.description ?? undefined,
      logo: input.logo ?? undefined,
      url: `${PLATFORM_ORIGIN}/shop/${input.slug}`,
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
        target: `${PLATFORM_ORIGIN}/?search={search_term_string}`,
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
