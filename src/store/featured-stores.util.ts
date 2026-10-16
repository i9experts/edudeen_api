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

export interface ProfileCheckItem { key: 'logo' | 'banner' | 'bio' | 'products'; label: string; done: boolean; detail: string }
export interface ProfileCompleteness { percent: number; complete: boolean; items: ProfileCheckItem[] }

/** The seller-dashboard meter: the SAME four requirements the homepage Featured sellers rail uses. */
export function buildProfileCompleteness(store: { logo?: string | null; coverImage?: string | null; description?: string | null }, publishedProducts: number): ProfileCompleteness {
  const bioLen = (store.description ?? '').trim().length;
  const items: ProfileCheckItem[] = [
    { key: 'logo', label: 'Store logo', done: !!store.logo && !!String(store.logo).trim(), detail: 'Upload your logo' },
    { key: 'banner', label: 'Store banner', done: !!store.coverImage && !!String(store.coverImage).trim(), detail: 'Add a banner image' },
    { key: 'bio', label: `Store bio (${FEATURED_MIN_BIO_CHARS}+ characters)`, done: bioLen >= FEATURED_MIN_BIO_CHARS, detail: bioLen >= FEATURED_MIN_BIO_CHARS ? 'Done' : `${bioLen}/${FEATURED_MIN_BIO_CHARS} characters` },
    { key: 'products', label: `${FEATURED_MIN_PRODUCTS}+ published products`, done: publishedProducts >= FEATURED_MIN_PRODUCTS, detail: `${Math.min(publishedProducts, FEATURED_MIN_PRODUCTS)}/${FEATURED_MIN_PRODUCTS} published` },
  ];
  const done = items.filter((i) => i.done).length;
  return { percent: Math.round((done / items.length) * 100), complete: done === items.length, items };
}