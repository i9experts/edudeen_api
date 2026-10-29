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

// ── Quality gate + ranking for the rail (see getTopStores) ──
export const FEATURED_QUALITY_MIN_PRODUCTS = 3;
export const FEATURED_MAX_PER_CATEGORY_RUN = 2;
const BAYES_PRIOR_MEAN = 4;
const BAYES_PRIOR_WEIGHT = 5;
const RECENCY_DAYS = 60;

export interface FeaturedSignals {
  averageRating?: number | null;
  reviewCount?: number | null;
  followersCount?: number | null;
  logo?: string | null;
  coverImage?: string | null;
  description?: string | null;
  categoryId?: string | null;
  featuredRank?: number | null;
  publishedProducts: number;
  /** Sum of purchaseCount over the store's published products. */
  soldCount: number;
  /** Newest product/sale activity (ms since epoch), if known. */
  lastActivityAt?: number | null;
}

/** Rating pulled toward the platform mean so one 5-star review cannot beat a store with 200 good ones. */
export function bayesianRating(avg: number, count: number): number {
  const v = Math.max(0, count || 0);
  return ((v * (avg || 0)) + (BAYES_PRIOR_WEIGHT * BAYES_PRIOR_MEAN)) / (v + BAYES_PRIOR_WEIGHT);
}

export function recencyFactor(lastActivityAt: number | null | undefined, now = Date.now()): number {
  if (!lastActivityAt) return 0;
  const days = (now - lastActivityAt) / 86_400_000;
  if (days <= 0) return 1;
  return Math.max(0, 1 - days / RECENCY_DAYS);
}

/** Stricter rule than isFeaturedStoreEligible: real, finished stores only. */
export function isQualityStore(s: FeaturedSignals): boolean {
  const hasLogo = !!s.logo && !!String(s.logo).trim();
  const bioOk = (s.description ?? '').trim().length >= PROFILE_MIN_BIO_CHARS;
  return s.publishedProducts >= FEATURED_QUALITY_MIN_PRODUCTS && hasLogo && (bioOk || s.publishedProducts >= PROFILE_MIN_PRODUCTS);
}

/** 0..100 featured score. Weights: rating 35, sales 30, followers 15, profile 10, recency 10. */
export function featuredScore(s: FeaturedSignals, now = Date.now()): number {
  const rating = bayesianRating(s.averageRating ?? 0, s.reviewCount ?? 0) / 5;
  const sales = Math.min(1, Math.log10(1 + Math.max(0, s.soldCount)) / 3); // 1000 sales = full marks
  const followers = Math.min(1, Math.log10(1 + Math.max(0, s.followersCount ?? 0)) / 3);
  const profile = buildProfileCompleteness(s, s.publishedProducts).percent / 100;
  const recency = recencyFactor(s.lastActivityAt, now);
  const total = 0.35 * rating + 0.30 * sales + 0.15 * followers + 0.10 * profile + 0.10 * recency;
  return Math.round(total * 1000) / 10;
}

/** Pinned (featuredRank) first by rank, then by score; at most N same-category stores in a row. */
export function rankFeatured<T extends FeaturedSignals & { score: number }>(rows: T[], limit: number): T[] {
  const pinned = rows.filter((r) => typeof r.featuredRank === 'number').sort((a, b) => (a.featuredRank! - b.featuredRank!) || (b.score - a.score));
  const rest = rows.filter((r) => typeof r.featuredRank !== 'number').sort((a, b) => b.score - a.score);
  const out: T[] = [...pinned];
  const queue = [...rest];
  while (queue.length && out.length < limit) {
    const tail = out.slice(-FEATURED_MAX_PER_CATEGORY_RUN);
    const sameRun = tail.length === FEATURED_MAX_PER_CATEGORY_RUN && tail.every((t) => t.categoryId && t.categoryId === tail[0].categoryId);
    let idx = 0;
    if (sameRun) {
      const alt = queue.findIndex((q) => q.categoryId !== tail[0].categoryId);
      if (alt >= 0) idx = alt;
    }
    out.push(queue.splice(idx, 1)[0]);
  }
  return out.slice(0, Math.max(limit, 0));
}

/** Only quality stores (or admin-pinned ones with a published product). No "show everyone" fallback: a thin rail is hidden by the web instead. */
export function selectFeatured<T extends FeaturedSignals & { score: number }>(all: T[], limit: number): T[] {
  const pool = all.filter((s) => s.publishedProducts >= FEATURED_MIN_PRODUCTS && (isQualityStore(s) || typeof s.featuredRank === 'number'));
  return rankFeatured(pool, limit);
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