import { QUALITY_LOW, QUALITY_GOOD, listingQuality, QualityInput } from './product-quality.util';

const full: QualityInput = {
  name: 'Grade 5 Complete Maths Workbook - Noor Publishers',
  isPhysical: false,
  isCourse: false,
  imageCount: 4,
  description: 'x'.repeat(300),
  hasCategory: true,
  hasSubCategory: true,
  classFrom: 'class-5',
  classTo: 'class-5',
  tagCount: 4,
  hasPreview: true,
  lessonCount: 0,
  coverStyle: 'book',
};

describe('listingQuality', () => {
  it('a complete digital listing scores 100 with nothing missing', () => {
    const r = listingQuality(full);
    expect(r.score).toBe(100);
    expect(r.missing).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(QUALITY_GOOD);
  });

  it('1 image + short description scores lower and says why', () => {
    const r = listingQuality({ ...full, imageCount: 1, description: 'Short text here, 30 chars ok' });
    expect(r.score).toBeLessThan(listingQuality(full).score);
    expect(r.missing.join('|')).toMatch(/more photos/);
    expect(r.missing.join('|')).toMatch(/longer description/);
  });

  it('a bare listing is below the low-quality line', () => {
    const r = listingQuality({ name: 'Maths', isPhysical: false, isCourse: false, imageCount: 0, description: '', hasCategory: false, hasSubCategory: false, tagCount: 0, hasPreview: false, lessonCount: 0 });
    expect(r.score).toBeLessThan(QUALITY_LOW);
    expect(r.missing).toEqual(expect.arrayContaining(['Add photos', 'Add a description', 'Pick a category', 'Set the class range', 'Add search tags']));
  });

  it('physical goods are not penalised for class range or preview', () => {
    const r = listingQuality({ ...full, isPhysical: true, classFrom: null, classTo: null, hasPreview: false });
    expect(r.score).toBe(100);
  });

  it('courses need a lesson instead of a preview file', () => {
    expect(listingQuality({ ...full, isCourse: true, hasPreview: false, lessonCount: 0 }).missing).toContain('Add at least one lesson');
    expect(listingQuality({ ...full, isCourse: true, hasPreview: false, lessonCount: 3 }).score).toBe(100);
  });

  it('legacy listing without a card style is told to choose one', () => {
    expect(listingQuality({ ...full, coverStyle: null }).missing).toContain('Choose a product card style');
  });
});

import { basicListingQuality, placeholderTitle } from './product-quality.util';
import { demoteLowQuality } from './home-rail.util';

describe('basicListingQuality (admin filter, seller tips, rail ranking)', () => {
  const good = { name: 'Grade 5 Complete Maths Workbook', images: ['a', 'b'], description: 'x'.repeat(80) };
  it('a good listing passes every check', () => {
    expect(basicListingQuality(good)).toEqual({ score: 100, reasons: [], low: false });
  });
  it('boundaries: 1 image, 79 chars, 14-char title fail; 2 / 80 / 15 pass', () => {
    expect(basicListingQuality({ ...good, images: ['a'] }).reasons.join()).toMatch(/at least 2 images/);
    expect(basicListingQuality({ ...good, description: 'x'.repeat(79) }).reasons.join()).toMatch(/at least 80 characters/);
    expect(basicListingQuality({ ...good, name: 'Maths Workbooks' }).low).toBe(false); // 15 chars
    expect(basicListingQuality({ ...good, name: 'Maths Workbook' }).reasons.join()).toMatch(/at least 15 characters/); // 14
  });
  it('html in the description does not count as text; a missing doc is just low', () => {
    expect(basicListingQuality({ ...good, description: '<p>' + 'x'.repeat(70) + '</p>' }).low).toBe(true);
    expect(basicListingQuality({}).score).toBe(0);
  });
  it('placeholder titles: words and a digit glued to the last word', () => {
    expect(placeholderTitle('Brouchure1')).toBe(true);
    expect(placeholderTitle('Demo product for class 5')).toBe(true);
    expect(placeholderTitle('Product name here')).toBe(true);
    expect(basicListingQuality({ ...good, name: 'Grade 5 Maths Workbook Brouchure1' }).low).toBe(true);
  });
  it('real education titles are not placeholders', () => {
    expect(placeholderTitle('Class 5 Complete Maths Workbook Vol 2')).toBe(false);
    expect(placeholderTitle('Matric Sample Papers 2025 - Physics')).toBe(false);
    expect(placeholderTitle('MDCAT Mock Test Series Class 12')).toBe(false);
    expect(placeholderTitle('IELTS Test Preparation Guide')).toBe(false);
  });
  it('demoteLowQuality keeps everything, moves low-quality last, stable inside each group', () => {
    const l = [{ id: 1, lowQuality: true }, { id: 2 }, { id: 3, lowQuality: true }, { id: 4 }];
    expect(demoteLowQuality(l).map((x) => x.id)).toEqual([2, 4, 1, 3]);
    expect(demoteLowQuality([])).toEqual([]);
  });
});