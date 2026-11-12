import { searchVisibility, SearchInput } from './product-quality.util';

const good: SearchInput = {
  name: 'Class 5 English Grammar Workbook - Complete Practice',
  description: 'x'.repeat(160),
  isPhysical: false, imageCount: 3, classFrom: 'class-5', classTo: 'class-5',
  hasSubject: true, language: 'en', boardCount: 1,
};

describe('searchVisibility', () => {
  it('complete product = 100 and nothing missing', () => {
    const r = searchVisibility(good);
    expect(r.score).toBe(100);
    expect(r.missing).toEqual([]);
  });

  it('blank SEO meta falls back to the product title/description (never 0)', () => {
    const r = searchVisibility({ ...good, name: 'English vocabulary Book', seoTitle: '', seoDescription: null });
    expect(r.score).toBeGreaterThan(60);
    expect(r.missing.map((m) => m.key)).toEqual(['title']);
    expect(r.missing[0].fix).toEqual({ step: 0, fieldId: 'ap-name' });
  });

  it('a custom SEO title is what is judged, and its fix opens the search section', () => {
    const r = searchVisibility({ ...good, seoTitle: 'Short' });
    expect(r.missing[0].fix.fieldId).toBe('fld-seo');
  });

  it('too long title is flagged', () => {
    const r = searchVisibility({ ...good, name: 'A'.repeat(75) });
    expect(r.missing.find((m) => m.key === 'title')?.label).toMatch(/Shorten/);
  });

  it('missing class/board/language/subject/photos map to wizard steps', () => {
    const r = searchVisibility({ ...good, imageCount: 1, classFrom: null, classTo: null, hasSubject: false, language: null, boardCount: 0 });
    const by = Object.fromEntries(r.missing.map((m) => [m.key, m.fix]));
    expect(by.images).toEqual({ step: 1, fieldId: 'fld-photos' });
    expect(by.classRange).toEqual({ step: 3, fieldId: 'fld-learning' });
    expect(by.board).toEqual({ step: 3, fieldId: 'fld-learning' });
    expect(by.language).toEqual({ step: 3, fieldId: 'fld-learning' });
    expect(by.subject).toEqual({ step: 3, fieldId: 'fld-category' });
  });

  it('physical goods are not asked for class range or board', () => {
    const r = searchVisibility({ ...good, isPhysical: true, classFrom: null, classTo: null, boardCount: 0 });
    expect(r.missing).toEqual([]);
    expect(r.score).toBe(100);
  });

  it('empty product scores low, not above 40', () => {
    const r = searchVisibility({ name: '', description: '', isPhysical: false, imageCount: 0, hasSubject: false, boardCount: 0 });
    expect(r.score).toBe(0);
    expect(r.missing.length).toBe(7);
  });
});
