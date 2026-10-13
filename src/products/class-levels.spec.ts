import { BadRequestException } from '@nestjs/common';
import { CLASS_VALUES, LEVEL_CLASSES, canonicalClass, classFilter, classRangeLabel, cleanClassRange, levelForClass, productCoversClass } from './class-levels';
import { cleanLearningMeta } from './product-input.util';
import { cleanChildInput } from '../children/children.service';
import { EducationLevel } from './schemas/product.schema';

/** Tiny matcher for the subset of Mongo operators classFilter uses ($or, $in, equality, null = missing). */
function matches(doc: Record<string, any>, f: Record<string, any>): boolean {
  return Object.entries(f).every(([k, cond]) => {
    if (k === '$or') return (cond as any[]).some((c) => matches(doc, c));
    const v = doc[k] ?? null;
    if (cond && typeof cond === 'object' && '$in' in cond) return (cond.$in as any[]).includes(v);
    return v === cond;
  });
}

describe('class levels', () => {
  it('maps every coarse level to known, ordered classes', () => {
    for (const cls of Object.values(LEVEL_CLASSES).flat()) expect(CLASS_VALUES).toContain(cls);
    expect(LEVEL_CLASSES.primary_school).toEqual(['class-1', 'class-2', 'class-3', 'class-4', 'class-5']);
    expect(levelForClass('class-7')).toBe('middle_school');
    expect(levelForClass('kg')).toBe('preschool');
    expect(levelForClass('nope')).toBeNull();
    for (const l of Object.values(EducationLevel)) {
      if (LEVEL_CLASSES[l]) expect(Object.keys(LEVEL_CLASSES)).toContain(l);
    }
  });

  it('covers by range, by legacy level, and by grade-N custom level', () => {
    expect(productCoversClass({ classFrom: 'class-2', classTo: 'class-4' }, 'class-3')).toBe(true);
    expect(productCoversClass({ classFrom: 'class-2', classTo: 'class-4' }, 'class-5')).toBe(false);
    // a range wins over the coarse level
    expect(productCoversClass({ classFrom: 'class-2', classTo: 'class-4', educationLevel: 'primary_school' }, 'class-5')).toBe(false);
    expect(productCoversClass({ classFrom: 'class-3' }, 'class-3')).toBe(true);
    expect(productCoversClass({ educationLevel: 'primary_school' }, 'class-3')).toBe(true);
    expect(productCoversClass({ educationLevel: 'primary_school' }, 'class-6')).toBe(false);
    expect(productCoversClass({ educationLevel: 'other', normalizedCustomLevel: 'grade-3' }, 'class-3')).toBe(true);
    expect(productCoversClass({ educationLevel: 'islamic_education' }, 'class-3')).toBe(false);
    expect(productCoversClass({}, 'class-3')).toBe(false);
    expect(productCoversClass({ educationLevel: 'primary_school' }, 'bogus')).toBe(false);
  });

  it('mongo filter agrees with the in-memory rule for every class', () => {
    const products = [
      { classFrom: 'class-2', classTo: 'class-4' },
      { classFrom: 'nursery', classTo: 'kg' },
      { classFrom: 'class-9', classTo: 'a-level' },
      { classFrom: 'class-3', classTo: null },
      { classFrom: null, classTo: 'class-6' },
      { educationLevel: 'preschool' }, { educationLevel: 'primary_school' }, { educationLevel: 'middle_school' },
      { educationLevel: 'secondary_school' }, { educationLevel: 'college' }, { educationLevel: 'university' },
      { educationLevel: 'professional_courses' }, { educationLevel: 'other', normalizedCustomLevel: 'grade-3' },
      { educationLevel: 'other', normalizedCustomLevel: 'grade-11' }, {},
    ];
    for (const cls of CLASS_VALUES) {
      const f = classFilter(cls)!;
      for (const p of products) expect({ cls, p, m: matches(p, f) }).toEqual({ cls, p, m: productCoversClass(p, cls) });
    }
    expect(classFilter('bogus')).toBeNull();
  });

  it('canonicalClass reads values, labels and old free text', () => {
    expect(canonicalClass('class-3')).toBe('class-3');
    expect(canonicalClass('Class 3')).toBe('class-3');
    expect(canonicalClass('grade 10')).toBe('class-10');
    expect(canonicalClass('3rd class')).toBe('class-3');
    expect(canonicalClass('KG')).toBe('kg');
    expect(canonicalClass('O Level')).toBe('o-level');
    expect(canonicalClass('Class 13')).toBeNull();
    expect(canonicalClass('Section B')).toBeNull();
    expect(canonicalClass(5)).toBeNull();
  });

  it('labels ranges', () => {
    expect(classRangeLabel('class-2', 'class-4')).toBe('Class 2-4');
    expect(classRangeLabel('class-3', 'class-3')).toBe('Class 3');
    expect(classRangeLabel('class-3', null)).toBe('Class 3');
    expect(classRangeLabel('nursery', 'kg')).toBe('Nursery - KG');
    expect(classRangeLabel(null, null)).toBeNull();
  });

  describe('seller input', () => {
    it('validates and normalises the range', () => {
      expect(cleanLearningMeta({ classFrom: 'class-2', classTo: 'class-4' })).toEqual({ classFrom: 'class-2', classTo: 'class-4' });
      expect(cleanLearningMeta({ classFrom: 'class-2', classTo: null })).toEqual({ classFrom: 'class-2', classTo: 'class-2' });
      expect(cleanLearningMeta({ classFrom: null, classTo: null })).toEqual({ classFrom: null, classTo: null });
      expect(cleanLearningMeta({ classFrom: '', classTo: '' })).toEqual({ classFrom: null, classTo: null });
      expect(cleanLearningMeta({})).toEqual({});
      expect(() => cleanLearningMeta({ classFrom: 'class-5', classTo: 'class-2' })).toThrow(BadRequestException);
      expect(() => cleanLearningMeta({ classFrom: 'class-99' })).toThrow(/classFrom/);
      expect(() => cleanClassRange({ classTo: 7 }, (m) => new Error(m))).toThrow(/classTo/);
    });
  });

  describe('child profile', () => {
    it('a class value derives the level', () => {
      expect(cleanChildInput({ name: 'Ali', gradeLabel: 'class-3' })).toMatchObject({ gradeLabel: 'class-3', educationLevel: 'primary_school' });
      expect(cleanChildInput({ name: 'Ali', educationLevel: 'college', gradeLabel: 'class-7' })).toMatchObject({ gradeLabel: 'class-7', educationLevel: 'middle_school' });
      expect(cleanChildInput({ gradeLabel: 'class-9' }, true)).toEqual({ gradeLabel: 'class-9', educationLevel: 'secondary_school' });
    });
    it('old free text is canonicalised when it is a class, else kept', () => {
      expect(cleanChildInput({ name: 'Ali', educationLevel: 'primary_school', gradeLabel: 'Class 3' }).gradeLabel).toBe('class-3');
      expect(cleanChildInput({ name: 'Ali', educationLevel: 'primary_school', gradeLabel: 'Section B' }).gradeLabel).toBe('Section B');
      expect(() => cleanChildInput({ name: 'Ali', gradeLabel: 'Section B' })).toThrow(/valid level/);
    });
  });
});
