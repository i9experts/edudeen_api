/**
 * Duplicate-listing check (non-blocking): the same store already has a product with a VERY similar title and the same price.
 * Pure helpers; the DB lookup lives in ProductsService.findDuplicateListing.
 */

/** Lower-case letters/digits (any script) only, single spaces: "Class 5 - Maths Workbook!" -> "class 5 maths workbook". */
export function titleKey(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-set overlap (Jaccard) of two normalised titles, 0..1. */
function overlap(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const DUPLICATE_TITLE_SIMILARITY = 0.85;

/** Same normalised title, or an overlap of at least 85% of the words. Needs 2+ words so "Maths" vs "Maths" short names never match loosely. */
export function titlesSimilar(a: unknown, b: unknown): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.split(' ').length < 3 || kb.split(' ').length < 3) return false;
  return overlap(ka, kb) >= DUPLICATE_TITLE_SIMILARITY;
}

export const samePrice = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;

/** The seller-facing sentence (also used as the needs_review reason). null when there is no duplicate. */
export function duplicateWarning(duplicateOf?: string | null): string | null {
  return duplicateOf
    ? `Looks like a duplicate of "${duplicateOf}" in your store (very similar title and the same price). If it is a different product, make the title clearer.`
    : null;
}
