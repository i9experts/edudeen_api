/* eslint-disable prettier/prettier */

/**
 * Shared placement enum for every promotional surface in the app — the
 * platform `Banner` module, `StoreBanner`, and `PromotionRequest` all key off
 * these same values so a seller-requested placement and an admin-authored
 * banner can occupy the same rotation slot. `storeHero` covers the
 * seller-owned storefront hero (used for `placementLimits`/visible-count
 * only — a `StoreBanner` is never itself a `PromotionRequest` target since
 * it's the seller's own real estate, not a shared/paid slot).
 *
 * Intentionally left open to grow — adding `sponsoredProduct` /
 * `sponsoredStore` / `searchAd` / `videoAd` later is additive here, not a
 * redesign (see the Promotion System implementation plan).
 */
export const PROMOTION_PLACEMENTS = [
  'homepageHero',
  'marketplaceHero',
  'educationHero',
  'categoryHero',
  // Banner shown on every product page — admin-authored only (not sold to sellers).
  'productPage',
] as const;

export type PromotionPlacement = (typeof PROMOTION_PLACEMENTS)[number];

/** Placements a seller may buy a promotion for; productPage is the platform's own slot. */
export const SELLER_PROMOTION_PLACEMENTS = PROMOTION_PLACEMENTS.filter((p) => p !== 'productPage') as unknown as readonly PromotionPlacement[];

/** Placements an admin can set a visible-count limit for, incl. the store hero. */
export const PLACEMENT_LIMIT_KEYS = [...PROMOTION_PLACEMENTS, 'storeHero', 'storeFeaturedProducts'] as const;

export type PlacementLimitKey = (typeof PLACEMENT_LIMIT_KEYS)[number];
