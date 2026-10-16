import { isPublicStoreUrl, publicHomeContent, sanitizeHomeContact, sanitizeHomeUrdu, sanitizeStatsThresholds } from './home-content.util';

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

  it('contact block: trimmed, markup removed, phone digits only, bad email dropped, missing = blank', () => {
    expect(sanitizeHomeContact(undefined)).toEqual({ phone: '', whatsapp: '', address: '', email: '' });
    expect(sanitizeHomeContact({ phone: ' +92 300-1234567 abc', whatsapp: '0300 1234567', address: '<b>12 Main Rd</b>,  Lahore', email: 'Help@Edudeen.com' }))
      .toEqual({ phone: '+92 300-1234567', whatsapp: '0300 1234567', address: '12 Main Rd, Lahore', email: 'help@edudeen.com' });
    expect(sanitizeHomeContact({ email: 'not-an-email' }).email).toBe('');
    expect(sanitizeHomeContact({ address: 'x'.repeat(500) }).address).toHaveLength(300);
  });

  it('public home content always carries a sanitized contact block', () => {
    expect(publicHomeContent({}).contact).toEqual({ phone: '', whatsapp: '', address: '', email: '' });
    expect(publicHomeContent({ contact: { phone: '123' } }).contact.phone).toBe('123');
  });});
