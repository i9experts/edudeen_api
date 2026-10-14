import { BadRequestException } from '@nestjs/common';
import { sanitizeSellerPage, SELLER_PAGE_LIMITS } from './seller-page.util';

describe('sanitizeSellerPage', () => {
  it('ignores unknown keys and returns nothing for an empty body', () => {
    expect(sanitizeSellerPage({ evil: { a: 1 }, __proto__x: 1 } as any)).toEqual({ set: {}, unset: {} });
    expect(sanitizeSellerPage(undefined)).toEqual({ set: {}, unset: {} });
  });

  it('only touches the sections that were sent (per-key merge)', () => {
    const { set, unset } = sanitizeSellerPage({ finalCta: { title: ' Join ', text: 't', button: 'Go' } });
    expect(Object.keys(set)).toEqual(['sellerPage.finalCta']);
    expect(set['sellerPage.finalCta']).toEqual({ title: 'Join', text: 't', button: 'Go' });
    expect(unset).toEqual({});
  });

  it('null resets a section via $unset', () => {
    const { set, unset } = sanitizeSellerPage({ faqs: null, hero: null });
    expect(set).toEqual({});
    expect(Object.keys(unset).sort()).toEqual(['sellerPage.faqs', 'sellerPage.hero']);
  });

  it('caps text length and list sizes, drops incomplete rows', () => {
    const faqs = Array.from({ length: 40 }, (_, i) => ({ q: `Q${i}`, a: 'x'.repeat(5000) }));
    faqs.push({ q: 'no answer', a: '' });
    const { set } = sanitizeSellerPage({ faqs, hero: { title: 'T'.repeat(999) } });
    const out = set['sellerPage.faqs'] as { q: string; a: string }[];
    expect(out).toHaveLength(SELLER_PAGE_LIMITS.faqs);
    expect(out[0].a).toHaveLength(1500);
    expect((set['sellerPage.hero'] as any).title).toHaveLength(200);
  });

  it('normalises icons, mock kinds and bullets of lists', () => {
    const { set } = sanitizeSellerPage({
      steps: [{ title: 'One', text: 'a', icon: 'nope' }, { title: '', text: 'dropped' }],
      featureRows: [{ title: 'Row', mockKind: 'weird', bullets: ['a', '', 'b', 'c', 'd', 'e', 'f', 'g'] }, { title: 'Row2', mockKind: 'sales' }],
    });
    expect(set['sellerPage.steps']).toEqual([{ title: 'One', text: 'a', icon: 'star' }]);
    const rows = set['sellerPage.featureRows'] as any[];
    expect(rows[0].mockKind).toBe('none');
    expect(rows[0].bullets).toHaveLength(SELLER_PAGE_LIMITS.bullets);
    expect(rows[1].mockKind).toBe('sales');
  });

  it('rejects non-https images and unsafe links', () => {
    expect(() => sanitizeSellerPage({ hero: { imageUrl: 'javascript:alert(1)' } })).toThrow(BadRequestException);
    expect(() => sanitizeSellerPage({ featureRows: [{ title: 'x', imageUrl: 'ftp://a/b.png' }] })).toThrow(BadRequestException);
    expect(() => sanitizeSellerPage({ supportCards: [{ title: 'x', ctaLink: 'javascript:alert(1)' }] })).toThrow(BadRequestException);
    expect(() => sanitizeSellerPage({ supportCards: [{ title: 'x', ctaLink: '//evil.com' }] })).toThrow(BadRequestException);
    const ok = sanitizeSellerPage({ supportCards: [{ title: 'x', ctaLink: '/help' }, { title: 'y', ctaLink: 'https://a.com' }] });
    expect((ok.set['sellerPage.supportCards'] as any[]).map(c => c.ctaLink)).toEqual(['/help', 'https://a.com']);
  });

  it('visible toggles are written per key and only booleans', () => {
    const { set } = sanitizeSellerPage({ visible: { faqs: false, hero: 'no', plans: true, bogus: false } });
    expect(set).toEqual({ 'sellerPage.visible.faqs': false, 'sellerPage.visible.plans': true });
  });
});
