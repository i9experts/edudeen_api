import { BadRequestException } from '@nestjs/common';
import { cleanIntroVideoUrl, cleanPlainText } from './store-policies.util';
import { CLASS_VALUES } from '../products/class-levels';

export const ABOUT_BIO_MAX = 1500;

/**
 * Limits for NEW values. A value that is unchanged is never re-checked against these, so a legacy store (e.g. a
 * 3000-character description saved when the cap was 5000) can still save its other fields.
 * Web mirror: edudeen_web/src/utils/storeProfileRules.ts - keep in step.
 */
export const STORE_LIMITS = { name: 60, tagline: 100, description: 1000 } as const;
export type StoreTextField = keyof typeof STORE_LIMITS;
/** The old caps; still the hard ceiling for any request, changed or not. */
const STORE_LEGACY_CAPS: Record<StoreTextField, number> = { name: 120, tagline: 200, description: 5000 };
export const STORE_PHONE_ERROR = 'Enter a valid Pakistani phone number, e.g. +92 3XX XXXXXXX (mobile) or 042 XXXXXXXX (landline)';

/**
 * Pakistani mobile (3XX XXXXXXX) or landline (area code + number, 9-10 digits without the 0) -> E.164 `+92...`.
 * Accepts +92 / 0092 / 92 / 0 prefixes, spaces, dashes and brackets. Anything else (letters, no prefix, wrong length) -> null.
 */
export function normalizeStorePhone(raw: string): string | null {
  const s = raw.trim();
  if (!s || !/^\+?[\d\s\-()]+$/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (s.startsWith('+')) {
    if (!d.startsWith('92')) return null;
    d = d.slice(2);
  } else if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length >= 11) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  else return null;
  if (/^3\d{9}$/.test(d)) return `+92${d}`;
  if (/^[24-9]\d{8,9}$/.test(d)) return `+92${d}`;
  return null;
}

/**
 * Name / tagline / description of a store. `value` must be text; the trimmed text may be at most STORE_LIMITS[field]
 * characters unless it equals `current` (legacy). `null`/'' clears tagline + description; the name is required.
 * Returns what to store.
 */
export function cleanStoreProfileText(field: StoreTextField, value: unknown, current: unknown): string | null {
  const legacy = STORE_LEGACY_CAPS[field];
  if (value === null && field !== 'name') return null;
  if (typeof value !== 'string' || value.length > legacy) {
    throw new BadRequestException(`${field} must be text of at most ${STORE_LIMITS[field]} characters`);
  }
  const t = value.trim();
  if (!t) {
    if (field === 'name') throw new BadRequestException('Store name is required');
    return null;
  }
  // The draft path flattens whitespace (cleanPlainText), so a legacy multi-line value must also match in that form.
  const same = typeof current === 'string' && (t === current || t === current.trim() || t === cleanPlainText(current));
  if (!same && t.length > STORE_LIMITS[field]) {
    throw new BadRequestException(`${field} must be text of at most ${STORE_LIMITS[field]} characters`);
  }
  return t;
}

/** Contact phone: `null`/'' clears it; an unchanged value is kept as is (legacy); a new one must normalise to +92... */
export function cleanStoreContactPhone(value: unknown, current: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw new BadRequestException(STORE_PHONE_ERROR);
  if (typeof current === 'string' && value.trim() === current.trim()) return current;
  const n = normalizeStorePhone(value);
  if (!n) throw new BadRequestException(STORE_PHONE_ERROR);
  return n;
}

/** Contact e-mail: `null`/'' clears it; an unchanged value is kept; a new one must look like an e-mail (max 254). */
export function cleanStoreContactEmail(value: unknown, current: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 254) throw new BadRequestException('contactEmail must be a valid email address');
  const t = value.trim();
  if (typeof current === 'string' && t === current.trim()) return current;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) throw new BadRequestException('contactEmail must be a valid email address');
  return t;
}

export interface CleanEducatorProfile {
  headline: string | null;
  qualifications: string[];
  experienceYears: number | null;
  subjects: string[];
  institutions: string[];
  teachingLevels: string[];
  introVideoUrl: string | null;
}

function text(v: unknown, field: string, max: number, required = false): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) {
    throw new BadRequestException(`${field} must be text of at most ${max} characters`);
  }
  return v;
}

/**
 * Teacher profile shown on the store page and product pages. `null` clears it.
 * `existingVideo` is kept when the caller does not send `introVideoUrl` (older clients rewrite the whole profile).
 */
export function cleanEducatorProfile(p: any, existingVideo: string | null | undefined): CleanEducatorProfile | null {
  if (p === null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) throw new BadRequestException('educatorProfile must be an object');
  const list = (v: unknown, field: string, maxItems: number) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > maxItems) throw new BadRequestException(`${field} can have at most ${maxItems} items`);
    return v.map((s) => text(s, field, 120, true).trim());
  };
  if (p.headline !== undefined && p.headline !== null) text(p.headline, 'headline', 160);
  const years = p.experienceYears;
  if (years !== undefined && years !== null && (typeof years !== 'number' || !Number.isInteger(years) || years < 0 || years > 70)) {
    throw new BadRequestException('experienceYears must be a whole number from 0 to 70');
  }
  return {
    headline: p.headline?.trim() || null,
    qualifications: list(p.qualifications, 'qualifications', 10),
    experienceYears: years ?? null,
    subjects: list(p.subjects, 'subjects', 15),
    institutions: list(p.institutions, 'institutions', 10),
    teachingLevels: list(p.teachingLevels, 'teachingLevels', 10),
    introVideoUrl: p.introVideoUrl === undefined ? existingVideo ?? null : cleanIntroVideoUrl(p.introVideoUrl),
  };
}

/** Same rule as updateStore: null / '' clears the About text. */
export function cleanAboutBio(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  text(v, 'aboutBio', ABOUT_BIO_MAX);
  return (v as string).trim() || null;
}

function httpsUrlOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  text(v, field, 2048);
  if (!/^https:\/\/[^\s]+$/i.test(v as string)) throw new BadRequestException(`${field} must be an https URL`);
  return v as string;
}

/**
 * Fixed lists behind the storefront "grades / subjects / languages" chips. Web mirror:
 * edudeen_web/src/constants/storeTeaching.ts - keep in step. Grades come from products/class-levels.ts.
 */
export const STORE_SUBJECTS = [
  { value: 'quran-tajweed', label: 'Quran & Tajweed' },
  { value: 'islamic-studies', label: 'Islamic Studies' },
  { value: 'arabic', label: 'Arabic' },
  { value: 'urdu', label: 'Urdu' },
  { value: 'english', label: 'English' },
  { value: 'mathematics', label: 'Mathematics' },
  { value: 'science', label: 'Science' },
  { value: 'physics', label: 'Physics' },
  { value: 'chemistry', label: 'Chemistry' },
  { value: 'biology', label: 'Biology' },
  { value: 'computer-science', label: 'Computer Science' },
  { value: 'social-studies', label: 'Social Studies' },
  { value: 'pakistan-studies', label: 'Pakistan Studies' },
  { value: 'general-knowledge', label: 'General Knowledge' },
  { value: 'early-learning', label: 'Early Learning' },
  { value: 'exam-prep', label: 'Exam Preparation' },
  { value: 'art-handwriting', label: 'Art & Handwriting' },
] as const;
export const TEACHING_LANGUAGES = [
  { value: 'urdu', label: 'Urdu' },
  { value: 'english', label: 'English' },
  { value: 'arabic', label: 'Arabic' },
  { value: 'other', label: 'Other' },
] as const;
export const TEACHING_MAX = { gradesServed: 18, subjects: 12, teachingLanguages: 4 } as const;
export type TeachingChipField = keyof typeof TEACHING_MAX;

/** Allowed values per field. `null`/`[]` clears. Unknown value, duplicate, non-array or too many = 400. Returns what to store. */
export function cleanTeachingChips(field: TeachingChipField, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const allowed: string[] = field === 'gradesServed' ? CLASS_VALUES
    : field === 'subjects' ? STORE_SUBJECTS.map((s) => s.value)
    : TEACHING_LANGUAGES.map((l) => l.value);
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be a list`);
  if (value.length > TEACHING_MAX[field]) throw new BadRequestException(`${field} can have at most ${TEACHING_MAX[field]} items`);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !allowed.includes(v)) throw new BadRequestException(`${field} has an unknown value`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** What a store-page draft holds. Every key is optional on input; missing keys fall back to `base`. */
export interface StorePageDraft {
  name: string;
  tagline: string | null;
  description: string | null;
  logo: string | null;
  coverImage: string | null;
  aboutBio: string | null;
  educatorProfile: CleanEducatorProfile | null;
  gradesServed: string[];
  subjects: string[];
  teachingLanguages: string[];
}

/**
 * Validates + sanitises a draft save. `base` = the draft saved so far, else the live Store values, so a partial body
 * never blanks anything. Text is plain (tags removed). The same cleaners as the instant Store save are used, so a
 * draft can never hold something Publish would later refuse.
 */
export function cleanStorePageDraft(input: Record<string, any>, base: StorePageDraft): StorePageDraft {
  const next: StorePageDraft = { ...base };
  // Same limits + same "unchanged legacy value is fine" rule as updateStore (cleanStoreProfileText).
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') throw new BadRequestException(`name must be text of at most ${STORE_LIMITS.name} characters`);
    next.name = cleanStoreProfileText('name', cleanPlainText(input.name.slice(0, STORE_LEGACY_CAPS.name + 1)), base.name) as string;
  }
  if (input.tagline !== undefined) {
    next.tagline = input.tagline === null ? null : cleanStoreProfileText('tagline', typeof input.tagline === 'string' ? cleanPlainText(input.tagline) : input.tagline, base.tagline);
  }
  if (input.description !== undefined) {
    next.description = input.description === null ? null : cleanStoreProfileText('description', typeof input.description === 'string' ? cleanPlainText(input.description) : input.description, base.description);
  }
  if (input.logo !== undefined) next.logo = httpsUrlOrNull(input.logo, 'logo');
  if (input.coverImage !== undefined) next.coverImage = httpsUrlOrNull(input.coverImage, 'coverImage');
  if (input.aboutBio !== undefined) next.aboutBio = cleanAboutBio(input.aboutBio);
  if (input.educatorProfile !== undefined) {
    next.educatorProfile = cleanEducatorProfile(input.educatorProfile, base.educatorProfile?.introVideoUrl);
  }
  for (const f of ['gradesServed', 'subjects', 'teachingLanguages'] as const) {
    if (input[f] !== undefined) next[f] = cleanTeachingChips(f, input[f]);
  }
  return next;
}

/** The draft's starting point = what buyers see now. */
export function storePageFromStore(s: any): StorePageDraft {
  return {
    name: s?.name ?? '',
    tagline: s?.tagline ?? null,
    description: s?.description ?? null,
    logo: s?.logo ?? null,
    coverImage: s?.coverImage ?? null,
    aboutBio: s?.aboutBio ?? null,
    educatorProfile: s?.educatorProfile ?? null,
    gradesServed: Array.isArray(s?.gradesServed) ? s.gradesServed : [],
    subjects: Array.isArray(s?.subjects) ? s.subjects : [],
    teachingLanguages: Array.isArray(s?.teachingLanguages) ? s.teachingLanguages : [],
  };
}
