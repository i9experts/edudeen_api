/**
 * Rules for the homepage "Featured sellers" rail: EVERY approved (active) store that has at least one published,
 * non-test listing is shown (best rated first). The profile checklist below (logo, banner, bio, 5+ listings) is a
 * separate seller-dashboard nudge and no longer hides a store from the rail.
 */
export const FEATURED_MIN_PRODUCTS = 1;
export const PROFILE_MIN_BIO_CHARS = 30;
export const PROFILE_MIN_PRODUCTS = 5;

/** Mongo filter for the cheap checks (everything except the product count). */
export function featuredStoreFilter(): Record<string, any> {
  return { status: 'active', isDelete: false };
}

/** Same rules in code - used on the candidates and by the unit test. */
export function isFeaturedStoreEligible(store: { status?: string }, publishedProducts: number): boolean {
  return store.status === 'active' && publishedProducts >= FEATURED_MIN_PRODUCTS;
}
export interface ProfileCheckItem { key: 'logo' | 'banner' | 'bio' | 'products'; label: string; done: boolean; detail: string }
export interface ProfileCompleteness { percent: number; complete: boolean; items: ProfileCheckItem[] }

/** The seller-dashboard meter: the SAME four requirements the homepage Featured sellers rail uses. */
export function buildProfileCompleteness(store: { logo?: string | null; coverImage?: string | null; description?: string | null }, publishedProducts: number): ProfileCompleteness {
  const bioLen = (store.description ?? '').trim().length;
  const items: ProfileCheckItem[] = [
    { key: 'logo', label: 'Store logo', done: !!store.logo && !!String(store.logo).trim(), detail: 'Upload your logo' },
    { key: 'banner', label: 'Store banner', done: !!store.coverImage && !!String(store.coverImage).trim(), detail: 'Add a banner image' },
    { key: 'bio', label: `Store bio (${PROFILE_MIN_BIO_CHARS}+ characters)`, done: bioLen >= PROFILE_MIN_BIO_CHARS, detail: bioLen >= PROFILE_MIN_BIO_CHARS ? 'Done' : `${bioLen}/${PROFILE_MIN_BIO_CHARS} characters` },
    { key: 'products', label: `${PROFILE_MIN_PRODUCTS}+ published products`, done: publishedProducts >= PROFILE_MIN_PRODUCTS, detail: `${Math.min(publishedProducts, PROFILE_MIN_PRODUCTS)}/${PROFILE_MIN_PRODUCTS} published` },
  ];
  const done = items.filter((i) => i.done).length;
  return { percent: Math.round((done / items.length) * 100), complete: done === items.length, items };
}