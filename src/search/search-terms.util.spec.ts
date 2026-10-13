import { FuzzyIndex, boundedEditDistance, buildSearchRegex, expandSearchTerms, normalizeSearchText } from './search-terms.util';

describe('search-terms.util', () => {
  it('normalises case, diacritics and Arabic letter variants', () => {
    expect(normalizeSearchText("  Qur'an-Pak ")).toBe('quran pak');
    expect(normalizeSearchText('قُرآن')).toBe(normalizeSearchText('قرآن'));
    expect(normalizeSearchText('قاعده')).toBe(normalizeSearchText('قاعدہ'));
  });

  it('expands Roman Urdu spellings and Urdu script both ways', () => {
    const v = expandSearchTerms('Noorani Qaida');
    expect(v[0]).toBe('Noorani Qaida');
    expect(v).toEqual(expect.arrayContaining(['nurani kaida', 'نورانی قاعدہ']));
    expect(expandSearchTerms('نماز')).toEqual(expect.arrayContaining(['namaz', 'salah', 'salat']));
    expect(expandSearchTerms('koran')).toEqual(expect.arrayContaining(['quran', 'قرآن']));
  });

  it('keeps the other words of a longer query', () => {
    expect(expandSearchTerms('salah worksheets')).toEqual(expect.arrayContaining(['namaz worksheets', 'salah worksheet']));
  });

  it('returns only the term when nothing matches, and nothing for blank', () => {
    expect(expandSearchTerms('algebra')).toEqual(['algebra', ]);
    expect(expandSearchTerms('  ')).toEqual([]);
  });

  it('builds a regex that matches variants and escapes input', () => {
    const rx = buildSearchRegex('salat');
    expect(rx.test('Learn Namaz step by step')).toBe(true);
    expect(rx.test('نماز سیکھیں')).toBe(true);
    expect(buildSearchRegex('c++').test('Learn C++ basics')).toBe(true);
    expect(() => buildSearchRegex('(((')).not.toThrow();
  });

  it('computes bounded edit distance', () => {
    expect(boundedEditDistance('worksheet', 'worksheet', 2)).toBe(0);
    expect(boundedEditDistance('wroksheet', 'worksheet', 2)).toBeLessThanOrEqual(2);
    expect(boundedEditDistance('abc', 'xyzxyz', 2)).toBe(3);
  });

  it('corrects misspelt words from the vocabulary only', () => {
    const idx = new FuzzyIndex();
    idx.build(['Noorani Qaida for kids', 'Tajweed rules worksheet', 'Maths worksheet grade 3', 'Worksheet bundle']);
    expect(idx.correct('woksheet')).toBe('worksheet');
    expect(idx.correct('tajwed rules')).toBe('tajweed rules');
    expect(idx.correct('worksheet')).toBeNull();
    expect(idx.correct('zzzzzzzz')).toBeNull();
    expect(new FuzzyIndex().correct('anything')).toBeNull();
  });
});
