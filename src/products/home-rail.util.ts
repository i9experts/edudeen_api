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
