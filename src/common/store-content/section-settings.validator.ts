/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { SectionType } from '../schemas/section.schema';

/**
 * Imperative per-type validation for seller-authored storefront content
 * (`Section.settings`/`Block.settings` on `StorePage`/`StoreTheme`, and later
 * `BlogPost.content` blocks). Mongoose keeps these fields loosely typed
 * (`Object`) so the shape can evolve without a migration; this is the one
 * place that actually enforces required keys, allow-lists, length caps, and —
 * the part that must never be skipped — link/image scheme sanitization.
 *
 * This matters more here than for admin-authored blobs (e.g.
 * `SeoLandingPage.content`) because these are seller-supplied and render on a
 * public page with zero platform chrome protecting it: an unvalidated `url`/
 * `imageUrl` field is a real XSS/open-redirect surface (`javascript:`,
 * `data:`, etc.), not just a data-quality concern.
 */

const MAX_BLOCKS_PER_SECTION = 20;

function required(value: unknown, field: string): void {
  if (value === undefined || value === null || value === '') {
    throw new BadRequestException(`${field} is required`);
  }
}

function maxLen(value: unknown, max: number, field: string): void {
  if (value === undefined || value === null) return;
  // Text fields must BE text: a non-string (object / array / number) used to pass this check and be stored verbatim.
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  if (value.length > max) throw new BadRequestException(`${field} must be ${max} characters or fewer`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new BadRequestException(`${field} contains characters that are not allowed`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): void {
  if (value !== undefined && !allowed.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

/** Every image/external-link field on a seller storefront must be a real https:// URL from the real upload/authoring flow — this alone rules out `javascript:`/`data:`/relative-path injection. */
function assertHttpsUrl(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) {
    throw new BadRequestException(`${field} must be a valid https:// URL`);
  }
}

// 'category'/'collection' let a nav link, footer link, or hero/image-with-text
// CTA point at the store's own category-browse or collection-detail page —
// see the Store Builder plan's Phase 4. Shape-only validation here (is a real
// id string present); the SERVICE layer (store-theme.service.ts,
// store-pages.service.ts) is responsible for confirming the referenced
// category/collection actually belongs to this store before saving — this
// validator has no DB access and never invents ownership guarantees it can't
// actually check.
export const LINK_TYPES = ['home', 'page', 'blog', 'external', 'category', 'collection'] as const;

function assertLinkTarget(link: unknown, field: string): void {
  if (link === undefined || link === null) return;
  if (typeof link !== 'object') throw new BadRequestException(`${field} is invalid`);
  const l = link as Record<string, unknown>;
  oneOf(l.linkType, LINK_TYPES, `${field}.linkType`);
  if (l.linkType === 'page') required(l.pageSlug, `${field}.pageSlug`);
  if (l.linkType === 'external') assertHttpsUrl(l.url, `${field}.url`);
  if (l.linkType === 'category') required(l.categoryId, `${field}.categoryId`);
  if (l.linkType === 'collection') required(l.collectionId, `${field}.collectionId`);
}

// ── Section-level settings ──────────────────────────────────────────────────

export function validateSectionSettings(type: SectionType, settings: Record<string, any>): void {
  maxLen(settings.heading, 120, 'settings.heading');

  switch (type) {
    case 'hero':
      oneOf(settings.heightPreset, ['small', 'medium', 'large'] as const, 'settings.heightPreset');
      break;
    case 'rich_text':
      oneOf(settings.alignment, ['left', 'center', 'right'] as const, 'settings.alignment');
      break;
    case 'featured_products':
      required(settings.source, 'settings.source');
      oneOf(settings.source, ['manual', 'category', 'collection', 'bestsellers', 'newArrivals', 'trending', 'pinned', 'onSale'] as const, 'settings.source');
      if (settings.source === 'category') required(settings.categoryId, 'settings.categoryId');
      if (settings.source === 'collection') required(settings.collectionId, 'settings.collectionId');
      if (settings.source === 'manual') {
        if (!Array.isArray(settings.productIds) || settings.productIds.length === 0) {
          throw new BadRequestException('settings.productIds is required when source is "manual"');
        }
        if (settings.productIds.length > 24) throw new BadRequestException('settings.productIds cannot exceed 24 products');
      }
      if (settings.limit !== undefined && (typeof settings.limit !== 'number' || settings.limit < 1 || settings.limit > 24)) {
        throw new BadRequestException('settings.limit must be between 1 and 24');
      }
      break;
    case 'product_catalog':
      oneOf(settings.defaultSort, ['newest', 'price_asc', 'price_desc', 'best_rated'] as const, 'settings.defaultSort');
      if (settings.columns !== undefined && ![2, 3, 4].includes(settings.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, or 4');
      }
      // Optional merchandising filter — at most one of the two (a catalog
      // scoped to both a category AND a collection at once isn't a
      // meaningful combination in this builder, and would silently mean
      // "intersection" to the reader when nothing computes that).
      if (settings.categoryId !== undefined && typeof settings.categoryId !== 'string') {
        throw new BadRequestException('settings.categoryId must be a string');
      }
      if (settings.collectionId !== undefined && typeof settings.collectionId !== 'string') {
        throw new BadRequestException('settings.collectionId must be a string');
      }
      if (settings.categoryId && settings.collectionId) {
        throw new BadRequestException('settings.categoryId and settings.collectionId cannot both be set');
      }
      break;
    case 'featured_category_grid':
      if (!Array.isArray(settings.categoryIds) || settings.categoryIds.length === 0) {
        throw new BadRequestException('settings.categoryIds is required');
      }
      if (settings.categoryIds.length > 12) throw new BadRequestException('settings.categoryIds cannot exceed 12 categories');
      break;
    case 'trust_badges':
      break; // content lives entirely in trust_badge_item blocks
    case 'newsletter':
      maxLen(settings.subtext, 200, 'settings.subtext');
      break;
    case 'video':
      required(settings.videoUrl, 'settings.videoUrl');
      if (typeof settings.videoUrl !== 'string' || !/^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//i.test(settings.videoUrl)) {
        throw new BadRequestException('settings.videoUrl must be a YouTube or Vimeo link');
      }
      oneOf(settings.aspectRatio, ['16:9', '4:3', '1:1'] as const, 'settings.aspectRatio');
      break;
    case 'image_with_text':
    case 'testimonials':
    case 'faq':
      break; // content lives entirely in blocks, no section-level settings beyond heading
  }
}

// ── Block-level settings (context = the block's `type` string) ─────────────

export function validateBlockSettings(blockType: string, settings: Record<string, any>): void {
  switch (blockType) {
    // Header/footer blocks (StoreTheme)
    case 'nav_link':
      required(settings.label, 'label');
      maxLen(settings.label, 40, 'label');
      required(settings.linkType, 'linkType');
      oneOf(settings.linkType, LINK_TYPES, 'linkType');
      if (settings.linkType === 'page') required(settings.pageSlug, 'pageSlug');
      if (settings.linkType === 'external') assertHttpsUrl(settings.url, 'url');
      if (settings.linkType === 'category') required(settings.categoryId, 'categoryId');
      if (settings.linkType === 'collection') required(settings.collectionId, 'collectionId');
      if (settings.highlight !== undefined && typeof settings.highlight !== 'boolean') {
        throw new BadRequestException('highlight must be a boolean');
      }
      break;
    case 'footer_column':
      required(settings.heading, 'heading');
      maxLen(settings.heading, 60, 'heading');
      if (!Array.isArray(settings.links)) throw new BadRequestException('links must be an array');
      if (settings.links.length > 10) throw new BadRequestException('links cannot exceed 10 per column');
      for (const link of settings.links) validateBlockSettings('nav_link', link);
      break;
    case 'social_link':
      required(settings.platform, 'platform');
      oneOf(settings.platform, ['facebook', 'instagram', 'x', 'tiktok', 'youtube', 'linkedin', 'whatsapp'] as const, 'platform');
      assertHttpsUrl(settings.url, 'url');
      break;
    case 'copyright_text':
      required(settings.text, 'text');
      maxLen(settings.text, 200, 'text');
      break;

    // hero section blocks
    case 'hero_slide':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      if (settings.mobileImageUrl !== undefined) assertHttpsUrl(settings.mobileImageUrl, 'mobileImageUrl');
      maxLen(settings.heading, 100, 'heading');
      maxLen(settings.subheading, 200, 'subheading');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      break;

    // rich_text / blog content blocks
    case 'paragraph':
      required(settings.text, 'text');
      maxLen(settings.text, 2000, 'text');
      break;
    case 'heading':
      required(settings.text, 'text');
      maxLen(settings.text, 150, 'text');
      oneOf(settings.level, ['h2', 'h3', 'h4'] as const, 'level');
      break;
    case 'image':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.caption, 200, 'caption');
      maxLen(settings.alt, 150, 'alt');
      break;
    case 'quote':
      required(settings.text, 'text');
      maxLen(settings.text, 500, 'text');
      maxLen(settings.author, 100, 'author');
      break;
    case 'list':
      if (!Array.isArray(settings.items) || settings.items.length === 0 || settings.items.length > 20) {
        throw new BadRequestException('items must be an array of 1-20 strings');
      }
      for (const item of settings.items) maxLen(item, 200, 'items[]');
      oneOf(settings.style, ['bullet', 'numbered'] as const, 'style');
      break;
    case 'divider':
      break;

    // image_with_text section blocks
    case 'image_text_pair':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 120, 'heading');
      maxLen(settings.body, 1000, 'body');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      oneOf(settings.imagePosition, ['left', 'right'] as const, 'imagePosition');
      break;

    // testimonials section blocks
    case 'testimonial':
      required(settings.quote, 'quote');
      maxLen(settings.quote, 500, 'quote');
      required(settings.authorName, 'authorName');
      maxLen(settings.authorName, 100, 'authorName');
      maxLen(settings.authorRole, 100, 'authorRole');
      if (settings.avatarUrl !== undefined) assertHttpsUrl(settings.avatarUrl, 'avatarUrl');
      if (settings.rating !== undefined && (typeof settings.rating !== 'number' || settings.rating < 1 || settings.rating > 5)) {
        throw new BadRequestException('rating must be between 1 and 5');
      }
      break;

    // faq section blocks
    case 'faq_item':
      required(settings.question, 'question');
      maxLen(settings.question, 200, 'question');
      required(settings.answer, 'answer');
      maxLen(settings.answer, 2000, 'answer');
      break;

    // trust_badges section blocks
    case 'trust_badge_item':
      required(settings.icon, 'icon');
      oneOf(settings.icon, ['truck', 'shield', 'refresh', 'headset', 'lock'] as const, 'icon');
      required(settings.text, 'text');
      maxLen(settings.text, 80, 'text');
      break;

    default:
      throw new BadRequestException(`Unknown block type: ${blockType}`);
  }
}

/** Validates every block in an array against the given expected type(s) — used when a section type only accepts one specific block type. */
export function validateBlocksOfType(blocks: { type: string; settings: Record<string, any> }[], allowedTypes: readonly string[]): void {
  if (blocks.length > MAX_BLOCKS_PER_SECTION) {
    throw new BadRequestException(`A section cannot have more than ${MAX_BLOCKS_PER_SECTION} blocks`);
  }
  for (const block of blocks) {
    if (!allowedTypes.includes(block.type)) {
      throw new BadRequestException(`Block type "${block.type}" is not allowed in this section`);
    }
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

/** Maps a section type to the block type(s) its `blocks` array is allowed to contain — empty array means the section takes no blocks. */
export const SECTION_ALLOWED_BLOCK_TYPES: Record<SectionType, readonly string[]> = {
  hero: ['hero_slide'],
  rich_text: ['paragraph', 'heading', 'image', 'quote', 'list', 'divider'],
  featured_products: [],
  product_catalog: [],
  image_with_text: ['image_text_pair'],
  testimonials: ['testimonial'],
  faq: ['faq_item'],
  video: [],
  featured_category_grid: [],
  trust_badges: ['trust_badge_item'],
  newsletter: [],
};
