/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- light unit test */
import { SeoResolutionService, firstText, firstImage } from './seo-resolution.service';
import { SeoSchemaGeneratorService } from './seo-schema-generator.service';
import { SeoPrerenderService } from './seo-prerender.service';
import { isRootStoreSlugCandidate } from './root-slug.util';

const lean = (v: any) => ({ lean: async () => v });
const long = 'Word '.repeat(80); // 400 chars

function build(opts: { product?: any; store?: any }) {
  const product = { _id: { toString: () => 'p1' }, name: 'Class 5 Maths', slug: 'class-5-maths', description: `<p>${long}</p>`, images: ['https://res.cloudinary.com/x/1.jpg', 'https://res.cloudinary.com/x/2.jpg'], storeId: 's1', status: 'active', type: 'digital', ...opts.product };
  const store = { _id: { toString: () => 's1' }, name: 'Ahad Learning Studio', slug: 'ahad-learning-studio', status: 'active', logo: 'https://res.cloudinary.com/x/logo.png', description: '', ...opts.store };
  const db: any = { repositories: {
    productModel: { findOne: () => lean(product) },
    storeModel: { findById: () => lean(store), findOne: () => lean(store) },
    categoryModel: { findById: () => lean(null) },
    productVariantModel: { find: () => lean([{ price: 500, currency: 'PKR', isDefault: true }]) },
  } };
  const platform: any = { getSettings: async () => ({ metaTemplates: [] }) };
  const redis: any = { isConnected: false };
  return new SeoResolutionService(db, redis, platform, new SeoSchemaGeneratorService());
}

describe('SEO meta fallback (blank seller meta)', () => {
  it('firstText / firstImage skip blank values', () => {
    expect(firstText('', '   ', null, undefined, ' hi ')).toBe('hi');
    expect(firstText('', '  ')).toBe('');
    expect(firstImage('', 'junk', '/og.png', 'https://a/b.jpg')).toBe('https://edudeen.com/og.png');
    expect(firstImage(null, ' ')).toBeNull();
  });

  it('product with BLANK meta falls back to title + 155-char description + first image', async () => {
    const svc = build({ product: { seo: { metaTitle: '   ', metaDescription: '', ogImage: '', ogTitle: ' ' } } });
    const m = await svc.resolve('product', 'class-5-maths');
    expect(m.title).toBe('Class 5 Maths | Ahad Learning Studio');
    expect(m.description.length).toBeLessThanOrEqual(155);
    expect(m.description.startsWith('Word Word')).toBe(true);
    expect(m.ogTitle).toBe(m.title);
    expect(m.ogDescription).toBe(m.description);
    expect(m.ogImage).toBe('https://res.cloudinary.com/x/1.jpg');
    const ld: any = m.jsonLd[0];
    expect(ld['@type']).toBe('Product');
    expect(ld.image).toEqual(['https://res.cloudinary.com/x/1.jpg', 'https://res.cloudinary.com/x/2.jpg']);
  });

  it('seller meta wins when it is filled in', async () => {
    const svc = build({ product: { seo: { metaTitle: 'My title', metaDescription: 'My desc', ogImage: 'https://x/og.jpg' } } });
    const m = await svc.resolve('product', 'class-5-maths');
    expect([m.title, m.description, m.ogImage]).toEqual(['My title', 'My desc', 'https://x/og.jpg']);
  });

  it('product without images uses the store logo as og:image; the page then falls back to the Edudeen default', async () => {
    const withLogo = await build({ product: { images: [] } }).resolve('product', 'class-5-maths');
    expect(withLogo.ogImage).toBe('https://res.cloudinary.com/x/logo.png');
    const none = await build({ product: { images: [] }, store: { logo: '' } }).resolve('product', 'class-5-maths');
    expect(none.ogImage).toBeNull();
    const html = new SeoPrerenderService({ repositories: {} } as any, {} as any, new SeoSchemaGeneratorService(), {} as any);
    // product() needs the DB, so check the render path directly with the page the controller would build
    const page = { title: none.title, description: none.description, canonical: none.canonicalUrl, ogImage: none.ogImage ?? 'https://edudeen.com/og-default.png', ogType: 'product', noindex: false, jsonLd: none.jsonLd, body: '' };
    expect(html.render(page)).toContain('<meta property="og:image" content="https://edudeen.com/og-default.png">');
  });

  it('store with BLANK meta uses name + description (<=155) and its logo', async () => {
    const svc = build({ store: { seo: { metaTitle: '', metaDescription: ' ' }, description: `<b>${long}</b>` } });
    const m = await svc.resolve('store', 'ahad-learning-studio');
    expect(m.title).toBe('Ahad Learning Studio | Edudeen');
    expect(m.description.length).toBeLessThanOrEqual(155);
    expect(m.ogImage).toBe('https://res.cloudinary.com/x/logo.png');
    expect(m.canonicalUrl).toBe('https://edudeen.com/shop/ahad-learning-studio');
  });

  it('store with no description falls back to a default line', async () => {
    const m = await build({ store: { description: '' } }).resolve('store', 'ahad-learning-studio');
    expect(m.description).toBe('Shop Ahad Learning Studio on Edudeen.');
  });

  it('render uses separate og title / description when given', () => {
    const svc = new SeoPrerenderService({ repositories: {} } as any, {} as any, {} as any, {} as any);
    const html = svc.render({ title: 'T', description: 'D', ogTitle: 'OT', ogDescription: 'OD', canonical: 'https://edudeen.com/x', ogImage: 'https://a/b.jpg', ogType: 'product', noindex: false, jsonLd: [], body: '' });
    expect(html).toContain('<meta property="og:title" content="OT">');
    expect(html).toContain('<meta property="og:description" content="OD">');
    expect(html).toContain('<title>T</title>');
  });
});

describe('root store slug', () => {
  it('only plausible, non-reserved slugs are looked up', () => {
    expect(isRootStoreSlugCandidate('ahad-learning-studio')).toBe(true);
    for (const s of ['about', 'admin', 'shop', 'login', 'a', 'Bad_Slug', 'x.png', 'a'.repeat(100), '0123456789abcdef01234567']) {
      expect(isRootStoreSlugCandidate(s)).toBe(false);
    }
  });
});
