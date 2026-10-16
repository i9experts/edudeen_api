import { FEATURED_MIN_PRODUCTS, featuredStoreFilter, isFeaturedStoreEligible } from './featured-stores.util';

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
