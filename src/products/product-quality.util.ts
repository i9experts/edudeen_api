import { BadRequestException } from '@nestjs/common';
import { CLASS_LEVELS, classIndex } from './class-levels';

/**
 * Title quality + class/age rules for seller products. Mirrors edudeen_web/.../products/productQuality.ts (the seller
 * forms and bulk upload use the web copy for instant feedback; this is the authority).
 *
 * Class range decision: REQUIRED for digital products (everything sold as a download / course / class,
 * i.e. everything except physical goods) once the listing is going live; OPTIONAL for physical goods (a pencil box
 * or school bag has no grade). Drafts may stay incomplete.
 */
export const MIN_TITLE_LENGTH = 10;

/** Trim, collapse spaces, capitalise the first letter ("class 5 maths workbook" -> "Class 5 maths workbook"). */
export function normalizeTitle(raw: unknown): string {
  // Titles are plain text: drop any HTML tags (and their stray angle brackets) before anything is stored.
  const s = String(raw ?? '').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function assertTitleRule(raw: unknown): void {
  const len = String(raw ?? '').trim().length;
  if (len < MIN_TITLE_LENGTH) {
    throw new BadRequestException(`Title must be at least ${MIN_TITLE_LENGTH} characters so buyers know what it is (now ${len}). Example: "Grade 5 Complete Course Book Set - Publisher Name".`);
  }
}

const GRADE_WORD = /\b(?:class|grade|g)\s*[-:#]?\s*(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\b/i;
const KNOWN_LEVEL = /\b(kg|nursery|prep)\b/i;

/** "Grade 5 Complete Course Book Set - Publisher Name" - the pattern suggested for vague titles. */
export const TITLE_SUGGESTION = 'Grade 5 Complete Course Book Set - Publisher Name';

/** Non-blocking: a title that says almost nothing ("Course G1", "Books class 5", "Worksheets 3"). */
export function vagueTitleWarning(title: string): string | null {
  const t = normalizeTitle(title);
  if (!t) return null;
  const vague = /^(course|books?|worksheets?|notes?|resource|resources)\s*(g|grade|class)?\s*\d+$/i.test(t);
  const words = t.split(/\s+/).filter(Boolean);
  const hasGrade = GRADE_WORD.test(t) || KNOWN_LEVEL.test(t);
  if (vague || (words.length < 3 && hasGrade)) {
    return `This title is quite vague. Say what it is, who it is for and who made it, e.g. "${TITLE_SUGGESTION}".`;
  }
  return null;
}

export interface TitleGrade { from: string; to: string; label: string }

/** Grade the title mentions: "Class 5", "Grade 3-5", "G1", "KG", "Nursery". null when none. */
export function titleGrade(title: string): TitleGrade | null {
  const m = GRADE_WORD.exec(title);
  if (m) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a >= 1 && a <= 12 && b >= a && b <= 12) return { from: `class-${a}`, to: `class-${b}`, label: a === b ? `Class ${a}` : `Class ${a}-${b}` };
  }
  const k = KNOWN_LEVEL.exec(title);
  if (k) {
    const v = k[1].toLowerCase();
    return { from: v, to: v, label: CLASS_LEVELS.find((c) => c.value === v)?.label ?? v };
  }
  return null;
}

const labelOf = (v: string) => CLASS_LEVELS.find((c) => c.value === v)?.label ?? v;
function rangeText(from: string, to: string): string {
  if (from === to) return labelOf(from);
  const n = (v: string) => (v.startsWith('class-') ? v.slice(6) : null);
  return n(from) && n(to) ? `${n(from)}-${n(to)}` : `${labelOf(from)} - ${labelOf(to)}`;
}

/**
 * Non-blocking mismatch between what the title says and the class range picked.
 * - "Class 5" in the title but 6-12 selected (no overlap)
 * - "Course G1" but a very wide range such as "All ages" (Nursery - University)
 * - "Beginner" but the range starts at Class 6 or later
 */
export function titleClassConflict(title: string, classFrom?: string | null, classTo?: string | null): string | null {
  const from = classFrom ?? classTo;
  const to = classTo ?? classFrom;
  const fi = classIndex(from);
  const ti = classIndex(to);
  if (fi < 0 || ti < 0) return null;
  const sel = rangeText(from as string, to as string);
  const g = titleGrade(title);
  if (g) {
    const gf = classIndex(g.from);
    const gt = classIndex(g.to);
    if (gt < fi || gf > ti) return `Title says ${g.label} but suitable classes are ${sel}. Please check one of them.`;
    if (ti - fi >= 8 && gt - gf <= 3) return `Title says ${g.label} but this is marked suitable for ${sel}. Narrow the class range if it is meant for ${g.label}.`;
    return null;
  }
  if (/\bbeginner\b/i.test(title) && fi >= classIndex('class-6')) {
    return `Title says Beginner but suitable classes are ${sel}. Please check the class range.`;
  }
  return null;
}

/** Digital listings need a class range to go live; physical goods do not. */
export function classRangeRequired(type: string | null | undefined, productType?: string | null): boolean {
  return !(type === 'physical' || (!type && productType === 'physical'));
}

export function assertClassRangeRule(opts: { type: string; classFrom?: string | null; classTo?: string | null; goingLive: boolean }): void {
  if (!opts.goingLive || !classRangeRequired(opts.type)) return;
  if (!opts.classFrom && !opts.classTo) {
    throw new BadRequestException('Choose the classes this is suitable for (e.g. Class 3 to Class 5) before publishing - buyers filter by class.');
  }
}

// ── Listing quality score (read-time only, nothing stored) ───────────────────────────────────────────
/** Points per check. A check that does not apply to a product (class range for physical goods, preview for physical) is dropped and the score re-scaled to 0-100. */
export const QUALITY_WEIGHTS = {
  title: 10,
  images: 20,
  description: 20,
  category: 10,
  classRange: 15,
  tags: 10,
  preview: 15,
  coverStyle: 10,
} as const;

export const QUALITY_GOOD = 80;
export const QUALITY_LOW = 60;

export interface QualityInput {
  name?: string | null;
  isPhysical: boolean;
  isCourse: boolean;
  imageCount: number;
  description?: string | null;
  hasCategory: boolean;
  hasSubCategory: boolean;
  classFrom?: string | null;
  classTo?: string | null;
  tagCount: number;
  /** digital downloads: a free sample or an enabled buyer preview exists */
  hasPreview: boolean;
  /** online courses: number of lessons */
  lessonCount: number;
  coverStyle?: string | null;
}

export interface QualityResult { score: number; missing: string[] }

/** 0-100 listing completeness + the plain-language list of what is missing/weak. Pure. */
export function listingQuality(i: QualityInput): QualityResult {
  const W = QUALITY_WEIGHTS;
  let earned = 0;
  let possible = 0;
  const missing: string[] = [];
  const add = (weight: number, got: number, msg: string | null) => {
    possible += weight;
    earned += weight * Math.max(0, Math.min(1, got));
    if (msg && got < 1) missing.push(msg);
  };

  const name = String(i.name ?? '').trim();
  const titleOk = name.length >= MIN_TITLE_LENGTH && !vagueTitleWarning(name);
  add(W.title, titleOk ? 1 : name.length >= MIN_TITLE_LENGTH ? 0.5 : 0, 'A clearer title (what it is, who it is for, who made it)');

  const img = Math.max(0, i.imageCount | 0);
  add(W.images, img >= 3 ? 1 : img === 2 ? 0.7 : img === 1 ? 0.4 : 0, img === 0 ? 'Add photos' : `Add more photos (${img} now, 3+ is best)`);

  const dlen = String(i.description ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
  add(W.description, dlen >= 250 ? 1 : dlen >= 100 ? 0.7 : dlen >= 20 ? 0.35 : 0, dlen < 20 ? 'Add a description' : 'A longer description (250+ characters)');

  add(W.category, (i.hasCategory ? 0.5 : 0) + (i.hasSubCategory ? 0.5 : 0), i.hasCategory ? 'Pick a sub-category' : 'Pick a category');

  if (!i.isPhysical) add(W.classRange, i.classFrom || i.classTo ? 1 : 0, 'Set the class range');

  add(W.tags, i.tagCount >= 3 ? 1 : i.tagCount >= 1 ? 0.5 : 0, i.tagCount === 0 ? 'Add search tags' : 'Add more search tags (3+)');

  if (i.isCourse) add(W.preview, i.lessonCount > 0 ? 1 : 0, 'Add at least one lesson');
  else if (!i.isPhysical) add(W.preview, i.hasPreview ? 1 : 0, 'Add a free sample or preview');

  add(W.coverStyle, i.coverStyle === 'book' || i.coverStyle === 'flat' ? 1 : 0, 'Choose a product card style');

  return { score: possible > 0 ? Math.round((earned / possible) * 100) : 0, missing };
}

// ── Search visibility score (read-time only; reuses the title/description/image rules above) ───────────
export const SEARCH_WEIGHTS = { title: 20, description: 20, images: 15, classRange: 15, subject: 10, language: 10, board: 10 } as const;
export const SEARCH_TITLE_MIN = 30;
export const SEARCH_TITLE_MAX = 60;
export const SEARCH_DESC_MIN = 150;

/** Where the "Fix" button sends the seller inside the product edit wizard. */
export type SearchFixTarget = { step: number; fieldId: string };
export type SearchCheckKey = keyof typeof SEARCH_WEIGHTS;
export interface SearchMissing { key: SearchCheckKey; label: string; fix: SearchFixTarget }

export interface SearchInput {
  name?: string | null;
  description?: string | null;
  /** Custom search-result title/description (product.seo). Blank = the product title/description are used instead. */
  seoTitle?: string | null;
  seoDescription?: string | null;
  isPhysical: boolean;
  imageCount: number;
  classFrom?: string | null;
  classTo?: string | null;
  hasSubject: boolean;
  language?: string | null;
  boardCount: number;
}

const plain = (s: unknown) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const FIX = {
  title: { step: 0, fieldId: 'ap-name' },
  seoTitle: { step: 0, fieldId: 'fld-seo' },
  description: { step: 0, fieldId: 'ap-desc' },
  seoDescription: { step: 0, fieldId: 'fld-seo' },
  images: { step: 1, fieldId: 'fld-photos' },
  learning: { step: 3, fieldId: 'fld-learning' },
  subject: { step: 3, fieldId: 'fld-category' },
} as const;

/**
 * 0-100 "how findable is this product" + what is missing. The text checked is the text Google would show:
 * the custom SEO title/description when the seller wrote one, else the product's own title/description
 * (so a product with blank SEO fields is NOT scored 0). Checks that do not apply (class range, board for physical goods)
 * are dropped and the score re-scaled. Pure.
 */
export function searchVisibility(i: SearchInput): { score: number; missing: SearchMissing[] } {
  const W = SEARCH_WEIGHTS;
  let earned = 0;
  let possible = 0;
  const missing: SearchMissing[] = [];
  const add = (key: SearchCheckKey, got: number, label: string | null, fix: SearchFixTarget) => {
    possible += W[key];
    earned += W[key] * Math.max(0, Math.min(1, got));
    if (label && got < 1) missing.push({ key, label, fix });
  };

  const custom = plain(i.seoTitle);
  const title = custom || plain(i.name);
  const tFix = custom ? FIX.seoTitle : FIX.title;
  const tl = title.length;
  if (tl === 0) add('title', 0, 'Add a title', FIX.title);
  else if (tl < SEARCH_TITLE_MIN) add('title', tl >= MIN_TITLE_LENGTH ? 0.5 : 0.2, `Make the title longer (${tl} characters, ${SEARCH_TITLE_MIN}-${SEARCH_TITLE_MAX} is best)`, tFix);
  else if (tl > SEARCH_TITLE_MAX) add('title', 0.7, `Shorten the title (${tl} characters, Google cuts it after ${SEARCH_TITLE_MAX})`, tFix);
  else add('title', !custom && vagueTitleWarning(title) ? 0.7 : 1, !custom && vagueTitleWarning(title) ? 'Say more in the title (what it is, who it is for)' : null, tFix);

  const customDesc = plain(i.seoDescription);
  const desc = customDesc || plain(i.description);
  const dFix = customDesc ? FIX.seoDescription : FIX.description;
  const dl = desc.length;
  add('description', dl >= SEARCH_DESC_MIN ? 1 : dl >= 100 ? 0.7 : dl >= 20 ? 0.4 : 0,
    dl === 0 ? 'Add a description' : `Write a longer description (${dl} characters, ${SEARCH_DESC_MIN}+ is best)`, dFix);

  const img = Math.max(0, i.imageCount | 0);
  add('images', img >= 3 ? 1 : img === 2 ? 0.66 : img === 1 ? 0.33 : 0, img === 0 ? 'Add photos' : `Add more photos (${img} now, 3+ is best)`, FIX.images);

  if (!i.isPhysical) add('classRange', i.classFrom || i.classTo ? 1 : 0, 'Set the class range', FIX.learning);
  add('subject', i.hasSubject ? 1 : 0, 'Pick the subject (sub-category)', FIX.subject);
  add('language', i.language ? 1 : 0, 'Say which language it is in', FIX.learning);
  if (!i.isPhysical) add('board', i.boardCount > 0 ? 1 : 0, 'Pick the exam board / syllabus', FIX.learning);

  return { score: possible > 0 ? Math.round((earned / possible) * 100) : 0, missing };
}

/** All non-blocking warnings for a title + class range (returned to the seller in the create/update response). */
export function productWarnings(title: string, classFrom?: string | null, classTo?: string | null): string[] {
  return [vagueTitleWarning(title), titleClassConflict(title, classFrom, classTo)].filter((w): w is string => !!w);
}