import { bayesianRating, featuredScore, isQualityStore, selectFeatured, buildProfileCompleteness, featuredStoreFilter, isFeaturedStoreEligible, PROFILE_MIN_PRODUCTS } from './featured-stores.util';

describe('featured sellers rules', () => {
  it('shows every approved store that has at least one published listing', () => {
    expect(isFeaturedStoreEligible({ status: 'active' }, 1)).toBe(true);
    expect(isFeaturedStoreEligible({ status: 'active' }, 9)).toBe(true);
  });
  it('hides stores with no published listing', () => {
    expect(isFeaturedStoreEligible({ status: 'active' }, 0)).toBe(false);
  });
  it('hides non-active stores', () => {
    expect(isFeaturedStoreEligible({ status: 'pending' }, 9)).toBe(false);
  });
  it('mongo filter only needs an active, not-deleted store (no logo/bio gate)', () => {
    expect(featuredStoreFilter()).toEqual({ status: 'active', isDelete: false });
  });
});

const base: { logo: string | null; description: string; publishedProducts: number; soldCount: number; categoryId: string } = { logo: 'l', description: 'x'.repeat(40), publishedProducts: 5, soldCount: 0, categoryId: 'c1' };
const row = (o: Partial<typeof base> & Record<string, any>) => { const s = { ...base, ...o }; return { ...s, score: featuredScore(s) }; };

describe('featured ranking', () => {
  it('bayesian rating: one 5-star review does not beat 200 good ones', () => {
    expect(bayesianRating(5, 1)).toBeLessThan(bayesianRating(4.7, 200));
  });
  it('quality gate needs logo, 3+ products and a bio (or 5+ products)', () => {
    expect(isQualityStore(row({}))).toBe(true);
    expect(isQualityStore(row({ logo: null }))).toBe(false);
    expect(isQualityStore(row({ publishedProducts: 2 }))).toBe(false);
    expect(isQualityStore(row({ description: 'nothing', publishedProducts: 4 }))).toBe(false);
    expect(isQualityStore(row({ description: 'nothing', publishedProducts: 5 }))).toBe(true);
  });
  it('score grows with sales and recency', () => {
    expect(row({ soldCount: 500 }).score).toBeGreaterThan(row({ soldCount: 0 }).score);
    expect(row({ lastActivityAt: Date.now() }).score).toBeGreaterThan(row({ lastActivityAt: Date.now() - 200 * 86_400_000 }).score);
  });
  it('pinned stores come first, by rank', () => {
    const out = selectFeatured([row({ id: 'a', soldCount: 900 }), row({ id: 'b', featuredRank: 2 }), row({ id: 'c', featuredRank: 1 })], 3) as any[];
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
  it('no more than 2 same-category stores in a row', () => {
    const rows = [row({ id: '1', soldCount: 900 }), row({ id: '2', soldCount: 800 }), row({ id: '3', soldCount: 700 }), row({ id: '4', categoryId: 'c2', soldCount: 1 })];
    const out = selectFeatured(rows, 4) as any[];
    expect(out.map((r) => r.id)).toEqual(['1', '2', '4', '3']);
  });
  it('never shows non-quality stores (no fallback), but keeps pinned ones', () => {
    expect(selectFeatured([row({ id: 'a', logo: null }), row({ id: 'b', publishedProducts: 1 })], 5)).toHaveLength(0);
    expect(selectFeatured([row({ id: 'a', logo: null, featuredRank: 1 })], 5)).toHaveLength(1);
  });
});

describe('seller profile meter', () => {
  it('is a separate checklist: logo, banner, 30+ char bio, 5+ published', () => {
    const full = buildProfileCompleteness({ logo: 'l', coverImage: 'c', description: 'x'.repeat(30) }, PROFILE_MIN_PRODUCTS);
    expect(full.percent).toBe(100);
    expect(full.complete).toBe(true);
    const half = buildProfileCompleteness({ logo: 'l', coverImage: null, description: 'short' }, 2);
    expect(half.percent).toBe(25);
    expect(half.items.filter((i) => !i.done).map((i) => i.key)).toEqual(['banner', 'bio', 'products']);
  });
});