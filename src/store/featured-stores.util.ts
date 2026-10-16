/**
 * Rules for the homepage "Featured sellers" rail. A store is only featured when it looks finished:
 * logo, banner (cover image), a real bio and enough published listings. ("Verified" now simply means an
 * active store - business verification no longer exists.)
 */
export const FEATURED_MIN_BIO_CHARS = 30;
export const FEATURED_MIN_PRODUCTS = 5;

/** Mongo filter for the cheap checks (everything except the product count). */
export function featuredStoreFilter(): Record<string, any> {
  return {
    status: 'active',
    isDelete: false,
    logo: { $nin: [null, ''] },
    coverImage: { $nin: [null, ''] },
    $expr: { $gte: [{ $strLenCP: { $trim: { input: { $ifNull: ['$description', ''] } } } }, FEATURED_MIN_BIO_CHARS] },
  };
}

/** Same rules in code - used on the candidates and by the unit test. */
export function isFeaturedStoreEligible(store: { status?: string; logo?: string | null; coverImage?: string | null; description?: string | null }, publishedProducts: number): boolean {
  if (store.status !== 'active') return false;
  if (!store.logo || !String(store.logo).trim()) return false;
  if (!store.coverImage || !String(store.coverImage).trim()) return false;
  if ((store.description ?? '').trim().length < FEATURED_MIN_BIO_CHARS) return false;
  return publishedProducts >= FEATURED_MIN_PRODUCTS;
}
