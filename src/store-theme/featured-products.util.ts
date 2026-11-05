import { BadRequestException, ForbiddenException } from '@nestjs/common';

export const MAX_FEATURED = 8;
const HEX24 = /^[0-9a-f]{24}$/i;

export interface FeaturedCandidate {
  _id: unknown;
  storeId?: unknown;
  status?: string;
  isDelete?: boolean;
  isTest?: boolean;
}

/** Ids as the seller sent them: trimmed, valid ObjectIds only, duplicates dropped (first wins, order kept). */
export function normalizeFeaturedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequestException('featuredProductIds must be a list');
  const out: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!HEX24.test(id)) throw new BadRequestException('Invalid product id');
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_FEATURED) throw new BadRequestException(`You can feature up to ${MAX_FEATURED} products`);
  return out;
}

/**
 * `rows` = the products found for `ids` (any store). A product that is not in THIS store (another seller's, or
 * unknown) is 403 — same answer for both so ids cannot be probed. Own products must be active, not deleted, not test.
 */
export function assertFeaturedOwned(ids: string[], rows: FeaturedCandidate[], storeId: string): void {
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p || String(p.storeId) !== String(storeId)) throw new ForbiddenException('You can only feature products from your own store');
  }
  for (const id of ids) {
    const p = byId.get(id)!;
    if (p.isDelete || p.isTest || p.status !== 'active') {
      throw new BadRequestException('Only active products can be featured');
    }
  }
}

export interface HighlightsConfig {
  featuredProductIds: string[];
  showNewArrivals: boolean;
  showBestSellers: boolean;
}

/** Live config for buyers. A store that never published a highlights block keeps its legacy pinned list as "featured". */
export function publishedHighlights(live: Partial<HighlightsConfig> | null | undefined, legacyPinned: string[] | null | undefined): HighlightsConfig {
  if (live) {
    return {
      featuredProductIds: Array.isArray(live.featuredProductIds) ? live.featuredProductIds.map(String).slice(0, MAX_FEATURED) : [],
      showNewArrivals: live.showNewArrivals === true,
      showBestSellers: live.showBestSellers === true,
    };
  }
  return { featuredProductIds: (legacyPinned ?? []).map(String).slice(0, MAX_FEATURED), showNewArrivals: false, showBestSellers: false };
}
