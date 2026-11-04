import { buildBrowseCombos } from './browse-combos.util';

const cats = [
  { _id: 'c1', slug: 'Math', parentId: null },
  { _id: 'c2', slug: 'algebra', parentId: 'c1' },
  { _id: 'c3', slug: 'urdu', parentId: null },
];

describe('buildBrowseCombos', () => {
  it('expands a class range, and counts a sub-category for its ancestor', () => {
    const out = buildBrowseCombos([{ categoryId: 'c1', subCategoryId: 'c2', classFrom: 'class-4', classTo: 'class-5', n: 2 }], cats);
    const keys = out.map((c) => `${c.cls}/${c.slug ?? ''}:${c.count}`);
    expect(keys).toEqual(expect.arrayContaining(['class-4/:2', 'class-5/:2', 'class-4/math:2', 'class-5/algebra:2', 'class-5/math:2']));
    expect(out.some((c) => c.cls === 'class-6')).toBe(false);
  });

  it('skips products without a class range and unknown classes', () => {
    expect(buildBrowseCombos([
      { categoryId: 'c1', classFrom: null, classTo: null, n: 5 },
      { categoryId: 'c1', classFrom: 'class-99', classTo: 'class-99', n: 5 },
      { categoryId: 'c1', classFrom: 'class-5', classTo: 'class-3', n: 5 },
    ], cats)).toEqual([]);
  });

  it('one-sided data counts as that single class; slugs are lower-cased', () => {
    const out = buildBrowseCombos([{ categoryId: 'c3', classFrom: null, classTo: 'kg', n: 1 }], cats);
    expect(out).toEqual(expect.arrayContaining([{ cls: 'kg', slug: null, count: 1 }, { cls: 'kg', slug: 'urdu', count: 1 }]));
  });

  it('is capped, class-only pages first, then biggest', () => {
    const out = buildBrowseCombos([
      { categoryId: 'c1', classFrom: 'class-1', classTo: 'class-1', n: 1 },
      { categoryId: 'c3', classFrom: 'class-1', classTo: 'class-1', n: 9 },
    ], cats, 2);
    expect(out).toHaveLength(2);
    expect(out[0].slug).toBeNull();
  });
});
