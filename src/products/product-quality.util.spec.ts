import { assertClassRangeRule, assertTitleRule, normalizeTitle, productWarnings, titleClassConflict, titleGrade, vagueTitleWarning } from './product-quality.util';
import { generateProductSlug, nextPreviousSlugs, slugifyTitle } from '../common/slug.util';

describe('title rules', () => {
  it('needs 10+ characters once trimmed', () => {
    expect(() => assertTitleRule('  Maths  ')).toThrow(/at least 10/);
    expect(() => assertTitleRule('Grade 5 Maths Workbook')).not.toThrow();
  });
  it('capitalises the first letter and tidies spaces', () => {
    expect(normalizeTitle('  class 5   maths workbook ')).toBe('Class 5 maths workbook');
    expect(normalizeTitle('')).toBe('');
  });
  it('warns on vague titles only', () => {
    expect(vagueTitleWarning('Course G1')).toMatch(/vague/);
    expect(vagueTitleWarning('Books class 5')).toMatch(/vague/);
    expect(vagueTitleWarning('Worksheets 3')).toMatch(/vague/);
    expect(vagueTitleWarning('Grade 5 Complete Course Book Set - Oxford')).toBeNull();
    expect(vagueTitleWarning('Noorani Qaida Colour Coded Set')).toBeNull();
  });
});

describe('title vs class range', () => {
  it('Class 5 title with Class 6-12 selected is a mismatch', () => {
    expect(titleClassConflict('Class 5 Science Guide', 'class-6', 'class-12')).toMatch(/Title says Class 5 but suitable classes are 6-12/);
  });
  it('Course G1 marked for all ages is a mismatch', () => {
    expect(titleClassConflict('Course G1 English', 'nursery', 'university')).toMatch(/Title says Class 1/);
  });
  it('Beginner Level tagged 6-12 is a mismatch', () => {
    expect(titleClassConflict('Beginner Level Arabic Course', 'class-6', 'class-12')).toMatch(/Beginner/);
  });
  it('matching or absent grades are fine', () => {
    expect(titleClassConflict('Class 5 Science Guide', 'class-4', 'class-6')).toBeNull();
    expect(titleClassConflict('Science Guide for everyone', 'class-6', 'class-12')).toBeNull();
    expect(titleClassConflict('Class 5 Science Guide', null, null)).toBeNull();
    expect(titleGrade('KG Rhymes Book')?.from).toBe('kg');
    expect(titleGrade('Grade 3-5 Maths')?.label).toBe('Class 3-5');
  });
  it('productWarnings combines both', () => {
    expect(productWarnings('Course G1', 'nursery', 'university').length).toBe(2);
  });
});

describe('class range requirement', () => {
  it('required to go live for digital/educational, optional for physical and drafts', () => {
    expect(() => assertClassRangeRule({ type: 'digital', goingLive: true })).toThrow(/Choose the classes/);
    expect(() => assertClassRangeRule({ type: 'digital', goingLive: false })).not.toThrow();
    expect(() => assertClassRangeRule({ type: 'physical', goingLive: true })).not.toThrow();
    expect(() => assertClassRangeRule({ type: 'digital', classFrom: 'class-1', goingLive: true })).not.toThrow();
  });
});

describe('product slugs', () => {
  it('uses the whole title, never truncated to a few words', () => {
    expect(slugifyTitle('Noorani Qaida Colour Coded Set | Jami Store')).toBe('noorani-qaida-colour-coded-set-jami-store');
    expect(slugifyTitle('Maths & Science: Class 5 (2025)')).toBe('maths-and-science-class-5-2025');
  });
  it('cuts long titles on a word boundary at <= 100 chars', () => {
    const s = slugifyTitle(Array(30).fill('workbook').join(' '));
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith('-')).toBe(false);
    expect(s.split('-').every((w) => w === 'workbook')).toBe(true);
  });
  it('adds a short suffix only on collision', async () => {
    const taken = new Set(['grade-5-maths']);
    const model: any = { exists: jest.fn(async (q: any) => (taken.has(q.$or[0].slug) ? { _id: 'x' } : null)) };
    expect(await generateProductSlug(model, 'Grade 5 Maths')).toMatch(/^grade-5-maths-[a-z2-9]{4}$/);
    expect(await generateProductSlug(model, 'Grade 6 Maths')).toBe('grade-6-maths');
  });
  it('previous slugs keep the old one and never list the current one', () => {
    expect(nextPreviousSlugs(['a'], 'b', 'c')).toEqual(['a', 'b']);
    expect(nextPreviousSlugs(['a', 'c'], 'b', 'c')).toEqual(['a', 'b']);
  });
});
