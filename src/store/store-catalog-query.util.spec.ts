import { parseCatalogParams, classFacetCounts } from './store-catalog-query.util';

const bad = (m: string) => new Error(m);
const isId = (v: string) => /^[a-f0-9]{24}$/.test(v);
const parse = (q: Record<string, any>) => parseCatalogParams(q, bad, isId);

describe('parseCatalogParams', () => {
  it('defaults to newest and accepts the whitelist', () => {
    expect(parse({}).sort).toBe('newest');
    for (const s of ['newest', 'price_asc', 'price_desc', 'best_rated']) expect(parse({ sort: s }).sort).toBe(s);
  });
  it('rejects an unknown sort', () => {
    expect(() => parse({ sort: 'cheapest' })).toThrow(/sort must be/);
  });
  it('validates class, subject and price', () => {
    expect(parse({ class: 'class-1' }).classClause).not.toBeNull();
    expect(() => parse({ class: 'class-99' })).toThrow();
    expect(() => parse({ subject: 'x' })).toThrow();
    expect(parse({ subject: 'a'.repeat(24).replace(/a/g, '1') }).subject).toBeDefined();
    expect(() => parse({ min: '-1' })).toThrow();
    expect(() => parse({ min: 'abc' })).toThrow();
    expect(() => parse({ min: '500', max: '100' })).toThrow();
    expect(parse({ min: '0', max: '500' })).toMatchObject({ min: 0, max: 500 });
  });
  it('takes q (or legacy search) and ignores operator objects', () => {
    expect(parse({ q: ' math ' }).q).toBe('math');
    expect(parse({ search: 'urdu' }).q).toBe('urdu');
    expect(parse({ q: { $ne: 'x' } }).q).toBeUndefined();
    expect(parse({ q: 'ریاضی' }).q).toBe('ریاضی');
  });
});

describe('classFacetCounts', () => {
  it('counts a range product for every class it covers and hides empty classes', () => {
    const out = classFacetCounts([
      { _id: { classFrom: 'class-1', classTo: 'class-3' }, count: 2 },
      { _id: { classFrom: 'class-2', classTo: 'class-2' }, count: 1 },
    ]);
    const by = Object.fromEntries(out.map((c) => [c.value, c.count]));
    expect(by['class-1']).toBe(2);
    expect(by['class-2']).toBe(3);
    expect(by['class-3']).toBe(2);
    expect(by['class-4']).toBeUndefined();
  });
});
