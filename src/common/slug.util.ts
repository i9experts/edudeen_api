import { Model } from 'mongoose';

/** Lowercase/hyphenate a name into a URL-safe base slug — same convention already used by Store's own slug generator. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Generate a slug for `name` that's unique within `model`'s `slug` field,
 * appending a numeric suffix on collision. `excludeId` lets a rename check
 * uniqueness against every other document without colliding with itself.
 */
export async function generateUniqueSlug(
  model: Model<any>,
  name: string,
  opts: { excludeId?: string } = {},
): Promise<string> {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let count = 1;

  while (
    await model.findOne({
      slug,
      ...(opts.excludeId ? { _id: { $ne: opts.excludeId } } : {}),
    })
  ) {
    slug = `${baseSlug}-${count}`;
    count++;
  }

  return slug;
}

/** Max length of a product slug (cut on a word boundary, never mid-word). */
export const PRODUCT_SLUG_MAX = 100;

/**
 * Clean slug from the FULL title: lowercase, accents stripped, "&" -> "and", everything else non-alphanumeric
 * becomes one hyphen. Longer than `max` -> cut at the last whole word that fits (no half words, no trailing hyphen).
 */
export function slugifyTitle(title: string, max = PRODUCT_SLUG_MAX): string {
  const base = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= max) return base || 'product';
  const cut = base.slice(0, max + 1);
  const at = cut.lastIndexOf('-');
  // No hyphen to cut on (one very long word): hard cut is the only option.
  const out = (at > 0 ? cut.slice(0, at) : base.slice(0, max)).replace(/-+$/g, '');
  return out || 'product';
}

const SUFFIX_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export function shortSuffix(len = 4, rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < len; i++) s += SUFFIX_CHARS[Math.floor(rand() * SUFFIX_CHARS.length)];
  return s;
}

/**
 * Unique product slug: the clean title slug as is; only on a collision (with another product's slug OR one of
 * its previous slugs, so an old link is never hijacked) a short random suffix is added. `excludeId` = the product itself.
 */
export async function generateProductSlug(
  model: Model<any>,
  title: string,
  opts: { excludeId?: string; rand?: () => number } = {},
): Promise<string> {
  const base = slugifyTitle(title);
  const taken = async (slug: string) =>
    !!(await model.exists({
      $or: [{ slug }, { previousSlugs: slug }],
      ...(opts.excludeId ? { _id: { $ne: opts.excludeId } } : {}),
    }));
  if (!(await taken(base))) return base;
  for (let i = 0; i < 20; i++) {
    const candidate = `${base.slice(0, PRODUCT_SLUG_MAX - 5).replace(/-+$/g, '')}-${shortSuffix(4, opts.rand)}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${base.slice(0, PRODUCT_SLUG_MAX - 14).replace(/-+$/g, '')}-${Date.now().toString(36)}`;
}

/** previousSlugs after a slug change: the old slug is kept (deduped, capped), the new one never listed. */
export function nextPreviousSlugs(previous: string[] | undefined, oldSlug: string | undefined, newSlug: string): string[] {
  const set = new Set([...(previous ?? []), ...(oldSlug ? [oldSlug] : [])]);
  set.delete(newSlug);
  return [...set].slice(-20);
}