/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { CATEGORY_NAME_LANGUAGES } from '../common/edu-filters.const';

/**
 * Per-category settings an admin can set (all optional; an unset value means "no rule"):
 * - icon / color: how the category tile looks in the kids-friendly UI.
 * - nameTranslations: the category name in other languages (the default `name` is English). The slug never changes.
 * - allowedProductTypes: what may be listed here (physical / digital / course). Empty = everything. A subcategory
 *   with an empty list inherits the nearest ancestor's list.
 * - requiresListingReview: a first publish into this category (or anything below it) always goes to admin review,
 *   even for stores whose plan normally skips review. Meant for Quran / Islamic content and products for kids.
 */
export const CATEGORY_PRODUCT_KINDS = ['physical', 'digital', 'course'] as const;
export type CategoryProductKind = (typeof CATEGORY_PRODUCT_KINDS)[number];

export const CATEGORY_ICON_MAX = 40;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Which kind a product counts as for `allowedProductTypes`. A course is a digital product with deliveryFormat 'course'. */
export function productKind(type: string | null | undefined, deliveryFormat?: string | null): CategoryProductKind {
  if (type === 'physical') return 'physical';
  return deliveryFormat === 'course' ? 'course' : 'digital';
}

export interface CategorySettingsInput {
  icon?: unknown;
  color?: unknown;
  nameTranslations?: unknown;
  allowedProductTypes?: unknown;
  requiresListingReview?: unknown;
}

export interface CategorySettings {
  icon?: string | null;
  color?: string | null;
  nameTranslations?: Record<string, string>;
  allowedProductTypes?: CategoryProductKind[];
  requiresListingReview?: boolean;
}

/** Validates the settings part of a create / update body. Only keys that were sent are returned. */
export function cleanCategorySettings(body: CategorySettingsInput): CategorySettings {
  const out: CategorySettings = {};
  if (body.icon !== undefined) {
    if (body.icon === null || body.icon === '') out.icon = null;
    else if (typeof body.icon !== 'string' || body.icon.trim().length > CATEGORY_ICON_MAX || /[<>]/.test(body.icon)) {
      throw new BadRequestException(`icon must be an icon name or emoji of at most ${CATEGORY_ICON_MAX} characters`);
    } else out.icon = body.icon.trim();
  }
  if (body.color !== undefined) {
    if (body.color === null || body.color === '') out.color = null;
    else if (typeof body.color !== 'string' || !HEX_COLOR.test(body.color)) throw new BadRequestException('color must be a hex colour like #1E7F5C');
    else out.color = body.color.toUpperCase();
  }
  if (body.nameTranslations !== undefined) {
    const t = body.nameTranslations;
    if (t === null) out.nameTranslations = {};
    else {
      if (typeof t !== 'object' || Array.isArray(t)) throw new BadRequestException('nameTranslations must be an object like { "ar": "...", "ur": "..." }');
      const clean: Record<string, string> = {};
      for (const [lang, value] of Object.entries(t as Record<string, unknown>)) {
        if (!(CATEGORY_NAME_LANGUAGES as readonly string[]).includes(lang)) {
          throw new BadRequestException(`nameTranslations keys must be one of: ${CATEGORY_NAME_LANGUAGES.join(', ')}`);
        }
        if (value === null || value === '') continue; // cleared
        if (typeof value !== 'string' || value.trim().length > 50 || /[<>]/.test(value)) {
          throw new BadRequestException(`nameTranslations.${lang} must be text of at most 50 characters`);
        }
        clean[lang] = value.trim();
      }
      out.nameTranslations = clean;
    }
  }
  if (body.allowedProductTypes !== undefined) {
    const a = body.allowedProductTypes;
    if (a === null) out.allowedProductTypes = [];
    else {
      if (!Array.isArray(a)) throw new BadRequestException('allowedProductTypes must be a list');
      for (const k of a) {
        if (!(CATEGORY_PRODUCT_KINDS as readonly unknown[]).includes(k)) {
          throw new BadRequestException(`allowedProductTypes items must be one of: ${CATEGORY_PRODUCT_KINDS.join(', ')}`);
        }
      }
      const picked = new Set(a as string[]);
      out.allowedProductTypes = CATEGORY_PRODUCT_KINDS.filter((k) => picked.has(k));
    }
  }
  if (body.requiresListingReview !== undefined) {
    if (typeof body.requiresListingReview !== 'boolean') throw new BadRequestException('requiresListingReview must be true or false');
    out.requiresListingReview = body.requiresListingReview;
  }
  return out;
}

export interface CategoryRuleNode {
  name?: string;
  allowedProductTypes?: string[] | null;
  requiresListingReview?: boolean | null;
}

/**
 * Effective rules for a product filed at the leaf of `chain` (ordered leaf first, root last):
 * the nearest non-empty `allowedProductTypes` wins; review is required if ANY node in the chain asks for it.
 */
export function effectiveCategoryRules(chain: CategoryRuleNode[]): { allowedProductTypes: CategoryProductKind[]; requiresListingReview: boolean; ruleFrom: string | null } {
  let allowed: CategoryProductKind[] = [];
  let ruleFrom: string | null = null;
  for (const node of chain) {
    if (node?.allowedProductTypes?.length) {
      allowed = node.allowedProductTypes.filter((k): k is CategoryProductKind => (CATEGORY_PRODUCT_KINDS as readonly string[]).includes(k));
      ruleFrom = node.name ?? null;
      break;
    }
  }
  return { allowedProductTypes: allowed, requiresListingReview: chain.some((n) => n?.requiresListingReview === true), ruleFrom };
}

const KIND_LABEL: Record<CategoryProductKind, string> = { physical: 'physical products', digital: 'digital downloads', course: 'courses' };

/** Throws when the category does not take this kind of product. */
export function assertKindAllowed(rules: { allowedProductTypes: CategoryProductKind[]; ruleFrom: string | null }, kind: CategoryProductKind): void {
  if (!rules.allowedProductTypes.length || rules.allowedProductTypes.includes(kind)) return;
  const allowed = rules.allowedProductTypes.map((k) => KIND_LABEL[k]).join(', ');
  throw new BadRequestException(`The category "${rules.ruleFrom ?? 'selected'}" does not take ${KIND_LABEL[kind]}. It accepts: ${allowed}.`);
}
