import { buildProfileCompleteness, featuredStoreFilter, isFeaturedStoreEligible, PROFILE_MIN_PRODUCTS } from './featured-stores.util';

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