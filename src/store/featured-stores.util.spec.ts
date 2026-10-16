import { buildProfileCompleteness, FEATURED_MIN_PRODUCTS, featuredStoreFilter, isFeaturedStoreEligible } from './featured-stores.util';

describe('featured sellers rules', () => {
  const ok = { status: 'active', logo: 'l.png', coverImage: 'c.png', description: 'We make printable Quran learning resources for kids.' };

  it('accepts a complete active store with enough listings', () => {
    expect(isFeaturedStoreEligible(ok, FEATURED_MIN_PRODUCTS)).toBe(true);
  });
  it('rejects a store with too few published items', () => {
    expect(isFeaturedStoreEligible(ok, FEATURED_MIN_PRODUCTS - 1)).toBe(false);
  });
  it('rejects missing logo, banner or a short/blank bio', () => {
    expect(isFeaturedStoreEligible({ ...ok, logo: null }, 9)).toBe(false);
    expect(isFeaturedStoreEligible({ ...ok, coverImage: '' }, 9)).toBe(false);
    expect(isFeaturedStoreEligible({ ...ok, description: 'Too short' }, 9)).toBe(false);
    expect(isFeaturedStoreEligible({ ...ok, description: null }, 9)).toBe(false);
    expect(isFeaturedStoreEligible({ ...ok, description: ' '.repeat(40) }, 9)).toBe(false);
  });
  it('rejects non-active stores', () => {
    expect(isFeaturedStoreEligible({ ...ok, status: 'pending' }, 9)).toBe(false);
  });
  it('mongo filter requires active, logo, cover and a bio length check', () => {
    const f = featuredStoreFilter();
    expect(f.status).toBe('active');
    expect(f.logo).toEqual({ $nin: [null, ''] });
    expect(f.coverImage).toEqual({ $nin: [null, ''] });
    expect(f.$expr).toBeDefined();
  });
});

describe('seller profile meter', () => {
  it('matches the featured rule: logo, banner, 30+ char bio, 5+ published', () => {
    const full = buildProfileCompleteness({ logo: 'l', coverImage: 'c', description: 'x'.repeat(30) }, 5);
    expect(full.percent).toBe(100);
    expect(full.complete).toBe(true);
    const half = buildProfileCompleteness({ logo: 'l', coverImage: null, description: 'short' }, 2);
    expect(half.percent).toBe(25);
    expect(half.items.filter((i) => !i.done).map((i) => i.key)).toEqual(['banner', 'bio', 'products']);
  });
});
