/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { AcademyService } from './academy.service';
import { applyLessonComplete, cleanCourseInput, cleanLesson, courseVisibleTo, sellerVisibilityFilter } from './academy.util';

describe('Edudeen Academy', () => {
  describe('country visibility', () => {
    const all = { status: 'published', countries: [] as string[] };
    const pkOnly = { status: 'published', countries: ['PK'] };
    const draft = { status: 'draft', countries: [] as string[] };

    it('shows all-country courses to everyone, including sellers without a store', () => {
      expect(courseVisibleTo(all, [])).toBe(true);
      expect(courseVisibleTo(all, ['AE'])).toBe(true);
    });

    it('shows country-specific courses only to sellers in that country', () => {
      expect(courseVisibleTo(pkOnly, ['PK'])).toBe(true);
      expect(courseVisibleTo(pkOnly, ['pk'])).toBe(true);
      expect(courseVisibleTo(pkOnly, ['AE'])).toBe(false);
      expect(courseVisibleTo(pkOnly, [])).toBe(false);
    });

    it('never shows drafts', () => {
      expect(courseVisibleTo(draft, ['PK'])).toBe(false);
    });

    it('builds the matching Mongo filter', () => {
      expect(sellerVisibilityFilter([])).toEqual({ status: 'published', $or: [{ countries: { $size: 0 } }] });
      expect(sellerVisibilityFilter(['pk', 'PK', 'AE'])).toEqual({
        status: 'published',
        $or: [{ countries: { $size: 0 } }, { countries: { $in: ['PK', 'AE'] } }],
      });
    });
  });

  describe('progress', () => {
    it('completes the course only when every lesson is done', () => {
      let r = applyLessonComplete(['a', 'b'], [], 'a');
      expect(r).toEqual({ completedLessonIds: ['a'], done: false });
      r = applyLessonComplete(['a', 'b'], r.completedLessonIds, 'b');
      expect(r.done).toBe(true);
    });

    it('ignores removed lessons and repeat completions', () => {
      const r = applyLessonComplete(['b'], ['a', 'b'], 'b');
      expect(r).toEqual({ completedLessonIds: ['b'], done: true });
    });

    it('an empty course is never complete', () => {
      expect(applyLessonComplete([], [], 'x').done).toBe(false);
    });
  });

  describe('admin validation', () => {
    it('requires a title on create', () => {
      expect(() => cleanCourseInput({}, false)).toThrow(BadRequestException);
      expect(cleanCourseInput({}, true)).toEqual({});
    });

    it('accepts only http(s) video, file and cover links', () => {
      expect(cleanLesson({ title: 'Intro', type: 'video', videoUrl: 'https://youtu.be/abc' }, 0).videoUrl).toBe('https://youtu.be/abc');
      expect(() => cleanLesson({ title: 'Intro', type: 'video', videoUrl: 'javascript:alert(1)' }, 0)).toThrow(BadRequestException);
      expect(() => cleanLesson({ title: 'Doc', type: 'pdf', fileUrl: 'ftp://x/y.pdf' }, 0)).toThrow(BadRequestException);
      expect(() => cleanCourseInput({ title: 'T', coverImage: 'data:image/png;base64,xx' }, false)).toThrow(BadRequestException);
    });

    it('requires the content each lesson type needs', () => {
      expect(() => cleanLesson({ title: 'V', type: 'video' }, 0)).toThrow('add a video link');
      expect(() => cleanLesson({ title: 'P', type: 'pdf' }, 0)).toThrow('add a PDF link');
      expect(() => cleanLesson({ title: 'T', type: 'text' }, 0)).toThrow('add the lesson text');
      expect(() => cleanLesson({ title: 'X', type: 'quiz', body: 'x' }, 0)).toThrow(BadRequestException);
    });

    it('validates countries and categories', () => {
      expect(cleanCourseInput({ title: 'T', countries: ['pk', 'PK', 'ae'] }, false).countries).toEqual(['PK', 'AE']);
      expect(() => cleanCourseInput({ title: 'T', countries: ['Pakistan'] }, false)).toThrow(BadRequestException);
      expect(() => cleanCourseInput({ title: 'T', category: 'random' }, false)).toThrow(BadRequestException);
    });
  });

  describe('slug uniqueness', () => {
    it('adds a numeric suffix when the slug is taken', async () => {
      const taken = new Set(['getting-started', 'getting-started-2']);
      const courseModel = { exists: jest.fn((q: { slug: string }) => Promise.resolve(taken.has(q.slug) ? { _id: 'x' } : null)) };
      const svc = new AcademyService(courseModel as never, {} as never, {} as never, { log: jest.fn() } as never);
      await expect(svc.uniqueSlug('Getting Started!')).resolves.toBe('getting-started-3');
      await expect(svc.uniqueSlug('Brand new')).resolves.toBe('brand-new');
    });

    it('ignores the course itself when renaming', async () => {
      const courseModel = { exists: jest.fn(() => Promise.resolve(null)) };
      const svc = new AcademyService(courseModel as never, {} as never, {} as never, { log: jest.fn() } as never);
      await svc.uniqueSlug('Shipping', '507f1f77bcf86cd799439011');
      expect(courseModel.exists).toHaveBeenCalledWith({ slug: 'shipping', _id: { $ne: '507f1f77bcf86cd799439011' } });
    });
  });
});
