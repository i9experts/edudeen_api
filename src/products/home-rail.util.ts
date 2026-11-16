/**
 * Home-page rail guard (Bestsellers, curated shelves). A product may sit in a discount-style rail only when its
 * displayed price is sane: price > 0, or price == 0 with NO strike-through price (a genuine free item); the
 * discount is below 100%. Shaped products carry `variants[]` with `price`, `compareAtPrice`, `campaignPrice`.
 * The web mirrors this in `homeRules.isValidRailProduct`.
 */
export function isValidRailProduct(p: any): boolean {
  const variants: any[] = Array.isArray(p?.variants) ? p.variants : [];
  const v = variants.find((x) => x?.isDefault) ?? variants[0];
  if (!v) return false;
  const price = Number(v.price);
  if (!Number.isFinite(price) || price < 0) return false;
  const campaign = typeof v.campaignPrice === 'number' && v.campaignPrice >= 0 && v.campaignPrice < price ? v.campaignPrice : null;
  const shown = campaign ?? price;
  const strike = campaign != null ? price : typeof v.compareAtPrice === 'number' && v.compareAtPrice > price ? v.compareAtPrice : null;
  if (shown > 0) return true;
  // shown == 0: only a genuine free item (nothing struck through) is allowed; "Rs 0, -100%" is not.
  return strike == null;
}

export function filterValidRailProducts<T>(products: T[]): T[] {
  return products.filter((p) => isValidRailProduct(p));
}

// ── "needs_review" listings stay on the store page and in search, but never in discovery rails ───────────
// ONE shared rule. Mongo side: spread RAIL_QUERY_EXCLUDE into a rail's candidate query (a cheap residual filter on the
// already-selective status/isDelete/isTest match; `flags` is not indexed and does not need to be). Shaped-product side:
// the public view exposes only the boolean `needsReview` (never the flags/reasons themselves).
export const RAIL_QUERY_EXCLUDE = { flags: { $ne: 'needs_review' } } as const;

/** Valid price AND not flagged for review. For Bestsellers, Premium deals, curated/featured shelves, flash/campaign rails. */
export function isRailEligible(p: any): boolean {
  return isValidRailProduct(p) && p?.needsReview !== true;
}

export function filterRailEligible<T>(products: T[]): T[] {
  return products.filter((p) => isRailEligible(p));
}
