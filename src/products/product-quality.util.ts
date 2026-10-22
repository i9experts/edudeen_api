import { BadRequestException } from '@nestjs/common';
import { CLASS_LEVELS, classIndex } from './class-levels';

/**
 * Title quality + class/age rules for seller products. Mirrors edudeen_web/.../products/productQuality.ts (the seller
 * forms and bulk upload use the web copy for instant feedback; this is the authority).
 *
 * Class range decision: REQUIRED for digital + educational products (everything sold as a download / course / class,
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

/** Digital + educational listings need a class range to go live; physical goods do not. */
export function classRangeRequired(type: string | null | undefined, productType?: string | null): boolean {
  return !(type === 'physical' || (!type && productType === 'physical'));
}

export function assertClassRangeRule(opts: { type: string; classFrom?: string | null; classTo?: string | null; goingLive: boolean }): void {
  if (!opts.goingLive || !classRangeRequired(opts.type)) return;
  if (!opts.classFrom && !opts.classTo) {
    throw new BadRequestException('Choose the classes this is suitable for (e.g. Class 3 to Class 5) before publishing - buyers filter by class.');
  }
}

/** All non-blocking warnings for a title + class range (returned to the seller in the create/update response). */
export function productWarnings(title: string, classFrom?: string | null, classTo?: string | null): string[] {
  return [vagueTitleWarning(title), titleClassConflict(title, classFrom, classTo)].filter((w): w is string => !!w);
}