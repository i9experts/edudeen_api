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
