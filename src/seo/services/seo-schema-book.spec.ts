import { SeoSchemaGeneratorService } from './seo-schema-generator.service';

describe('product JSON-LD book fields', () => {
  const gen = new SeoSchemaGeneratorService();
  const base = { productId: '1', name: 'Grade 5 Maths Book', description: 'd', images: [], slug: 'grade-5-maths-book', price: 10 };

  it('stays a plain Product when no book detail exists', () => {
    expect(gen.buildProductSchema(base)['@type']).toBe('Product');
    const s = gen.buildProductSchema({ ...base, book: { author: null, publisher: ' ', pages: null, isbn: null, binding: null, language: 'mixed' } });
    expect(s['@type']).toBe('Product');
    expect('isbn' in s || 'author' in s || 'inLanguage' in s).toBe(false);
  });

  it('adds only the Book fields that are present', () => {
    const s = gen.buildProductSchema({ ...base, book: { author: 'Ahmed Khan', pages: 240, isbn: '9780306406157', binding: 'spiral', language: 'ur' } });
    expect(s['@type']).toEqual(['Product', 'Book']);
    expect(s.author).toEqual({ '@type': 'Person', name: 'Ahmed Khan' });
    expect(s.numberOfPages).toBe(240);
    expect(s.isbn).toBe('9780306406157');
    expect(s.inLanguage).toBe('ur');
    expect('publisher' in s).toBe(false);
    expect('bookEdition' in s).toBe(false);
    expect('bookFormat' in s).toBe(false); // spiral has no schema.org BookFormatType
  });
});
