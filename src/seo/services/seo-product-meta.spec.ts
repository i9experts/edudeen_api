import { SeoSchemaGeneratorService } from './seo-schema-generator.service';
import { plainText } from './seo-resolution.service';

describe('product SEO data', () => {
  const gen = new SeoSchemaGeneratorService();
  const base = { productId: 'p1', name: 'Class 5 Maths', description: 'd', images: ['https://x/a.jpg'], slug: 'class-5-maths', price: 1200, currency: 'PKR', availability: 'InStock' as const, storeName: 'Edu Store' };

  it('keeps the product own currency and names the seller on the offer', () => {
    const s = gen.buildProductSchema(base);
    expect(s.offers.priceCurrency).toBe('PKR');
    expect(s.offers.seller).toEqual({ '@type': 'Organization', name: 'Edu Store' });
  });

  it('has no rating block without reviews', () => {
    expect(gen.buildProductSchema({ ...base, averageRating: 0, ratingCount: 0 }).aggregateRating).toBeUndefined();
    expect(gen.buildProductSchema({ ...base, averageRating: 4.5, ratingCount: 3 }).aggregateRating.reviewCount).toBe(3);
  });

  it('strips html from descriptions', () => {
    expect(plainText('<p>Hello&nbsp;<b>world</b></p>\n\n  &amp; more')).toBe('Hello world & more');
    expect(plainText(null)).toBe('');
  });
});
