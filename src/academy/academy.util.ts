/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ACADEMY_CATEGORIES, ACADEMY_LESSON_TYPES, type AcademyCategory, type AcademyLessonType } from './schemas/academy.schema';

export const ACADEMY_SORTS = ['recommended', 'most_viewed', 'latest'] as const;
export type AcademySort = (typeof ACADEMY_SORTS)[number];

const MAX_LESSONS = 50;
const MAX_BODY = 20_000;

export interface CleanLesson {
  _id?: string;
  title: string;
  type: AcademyLessonType;
  videoUrl: string | null;
  body: string;
  fileUrl: string | null;
  durationMinutes: number | null;
}

export interface CleanCourseInput {
  title?: string;
  summary?: string;
  coverImage?: string | null;
  category?: AcademyCategory;
  countries?: string[];
  language?: string | null;
  isRecommended?: boolean;
  order?: number;
  lessons?: CleanLesson[];
}

function str(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new BadRequestException(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new BadRequestException(`${field} is required`);
  if (s.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
  return s;
}

/** http(s) URL or null; anything else (javascript:, data:, relative paths) is rejected. */
export function httpUrl(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be a link`);
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    return u.toString();
  } catch {
    throw new BadRequestException(`${field} must be a full http(s) link`);
  }
}

export function cleanCountries(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new BadRequestException('countries must be a list of country codes');
  const out = new Set<string>();
  for (const c of v) {
    const code = typeof c === 'string' ? c.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(code)) throw new BadRequestException(`Invalid country code: ${String(c)}`);
    out.add(code);
  }
  return [...out];
}

export function cleanLesson(raw: unknown, index: number): CleanLesson {
  if (!raw || typeof raw !== 'object') throw new BadRequestException(`Lesson ${index + 1} is invalid`);
  const l = raw as Record<string, unknown>;
  const label = `Lesson ${index + 1}`;
  const type = (l.type ?? 'text') as AcademyLessonType;
  if (!ACADEMY_LESSON_TYPES.includes(type)) throw new BadRequestException(`${label}: type must be video, text or pdf`);
  const lesson: CleanLesson = {
    title: str(l.title, `${label} title`, 150, true),
    type,
    videoUrl: httpUrl(l.videoUrl, `${label} video link`),
    body: str(l.body, `${label} text`, MAX_BODY),
    fileUrl: httpUrl(l.fileUrl, `${label} file link`),
    durationMinutes: null,
  };
  if (l.durationMinutes !== undefined && l.durationMinutes !== null && l.durationMinutes !== '') {
    const n = Number(l.durationMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 600) throw new BadRequestException(`${label}: duration must be 0-600 minutes`);
    lesson.durationMinutes = n;
  }
  if (type === 'video' && !lesson.videoUrl) throw new BadRequestException(`${label}: add a video link`);
  if (type === 'pdf' && !lesson.fileUrl) throw new BadRequestException(`${label}: add a PDF link`);
  if (type === 'text' && !lesson.body) throw new BadRequestException(`${label}: add the lesson text`);
  if (typeof l._id === 'string' && /^[a-f0-9]{24}$/i.test(l._id)) lesson._id = l._id;
  return lesson;
}

/** Validates an admin create (`partial=false`) or update (`partial=true`) body. Unknown keys are ignored. */
export function cleanCourseInput(body: Record<string, unknown>, partial: boolean): CleanCourseInput {
  const out: CleanCourseInput = {};
  if (!partial || body.title !== undefined) out.title = str(body.title, 'Title', 150, true);
  if (body.summary !== undefined) out.summary = str(body.summary, 'Summary', 500);
  if (body.coverImage !== undefined) out.coverImage = httpUrl(body.coverImage, 'Cover image');
  if (body.category !== undefined) {
    if (!ACADEMY_CATEGORIES.includes(body.category as AcademyCategory)) throw new BadRequestException('Unknown category');
    out.category = body.category as AcademyCategory;
  }
  if (body.countries !== undefined) out.countries = cleanCountries(body.countries);
  if (body.language !== undefined) out.language = str(body.language, 'Language', 40) || null;
  if (body.isRecommended !== undefined) out.isRecommended = body.isRecommended === true;
  if (body.order !== undefined) {
    const n = Number(body.order);
    if (!Number.isFinite(n)) throw new BadRequestException('order must be a number');
    out.order = Math.trunc(n);
  }
  if (body.lessons !== undefined) {
    if (!Array.isArray(body.lessons)) throw new BadRequestException('lessons must be a list');
    if (body.lessons.length > MAX_LESSONS) throw new BadRequestException(`At most ${MAX_LESSONS} lessons per course`);
    out.lessons = body.lessons.map((l, i) => cleanLesson(l, i));
  }
  return out;
}

/** Mongo filter for the courses a seller operating in `countries` may see: published, and either for every country or one of theirs. */
export function sellerVisibilityFilter(countries: string[]): Record<string, unknown> {
  const codes = [...new Set(countries.filter(Boolean).map(c => c.toUpperCase()))];
  return {
    status: 'published',
    $or: [{ countries: { $size: 0 } }, ...(codes.length ? [{ countries: { $in: codes } }] : [])],
  };
}

export function courseVisibleTo(course: { status: string; countries?: string[] }, countries: string[]): boolean {
  if (course.status !== 'published') return false;
  const list = course.countries ?? [];
  if (!list.length) return true;
  const mine = new Set(countries.map(c => c.toUpperCase()));
  return list.some(c => mine.has(c));
}

export function sortFor(sort: AcademySort | undefined): Record<string, 1 | -1> {
  if (sort === 'most_viewed') return { viewCount: -1, publishedAt: -1 };
  if (sort === 'latest') return { publishedAt: -1, _id: -1 };
  return { isRecommended: -1, order: 1, publishedAt: -1 };
}

/** Adds a lesson to the completed set (only lessons that still exist count) and reports whether the course is now done. */
export function applyLessonComplete(lessonIds: string[], completed: string[], lessonId: string): { completedLessonIds: string[]; done: boolean } {
  const valid = new Set(lessonIds);
  const set = new Set(completed.filter(id => valid.has(id)));
  if (valid.has(lessonId)) set.add(lessonId);
  return { completedLessonIds: [...set], done: valid.size > 0 && set.size === valid.size };
}
