import { isPublicStoreUrl, publicHomeContent, sanitizeHomeUrdu, sanitizeStatsThresholds } from './home-content.util';

describe('home content helpers', () => {
  it('only public https store links count', () => {
    expect(isPublicStoreUrl('https://play.google.com/store/apps/details?id=com.edudeen')).toBe(true);
    expect(isPublicStoreUrl('https://apps.apple.com/app/id123')).toBe(true);
    expect(isPublicStoreUrl('https://play.google.com/apps/internaltest/4699462862361720775')).toBe(false);
    expect(isPublicStoreUrl('https://testflight.apple.com/join/abc')).toBe(false);
    expect(isPublicStoreUrl('http://play.google.com/store/apps/details?id=x')).toBe(false);
    expect(isPublicStoreUrl('')).toBe(false);
  });

  it('stats thresholds default to 50 sellers / 500 buyers and are clamped', () => {
    expect(sanitizeStatsThresholds(undefined)).toEqual({ sellers: 50, buyers: 500, products: 100 });
    expect(sanitizeStatsThresholds({ sellers: '10', buyers: -5, products: 'x' })).toEqual({ sellers: 10, buyers: 0, products: 100 });
  });

  it('public home content hides a stored internal-test link and always carries thresholds', () => {
    const out = publicHomeContent({ googlePlayUrl: 'https://play.google.com/apps/internaltest/1', appStoreUrl: 'https://apps.apple.com/app/id1' });
    expect(out.googlePlayUrl).toBe('');
    expect(out.appStoreUrl).toBe('https://apps.apple.com/app/id1');
    expect(out.statsThresholds.sellers).toBe(50);
  });

  it('urdu map keeps only known non-blank keys', () => {
    expect(sanitizeHomeUrdu({ heroTitle: ' بڑی دریافتیں ', heroText: '  ', bogus: 'x' })).toEqual({ heroTitle: 'بڑی دریافتیں' });
  });
});
