import { BadRequestException } from '@nestjs/common';
import { cleanIntroVideoUrl, cleanPlainText } from './store-policies.util';

export const ABOUT_BIO_MAX = 1500;

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

/** What a store-page draft holds. Every key is optional on input; missing keys fall back to `base`. */
export interface StorePageDraft {
  name: string;
  tagline: string | null;
  description: string | null;
  logo: string | null;
  coverImage: string | null;
  aboutBio: string | null;
  educatorProfile: CleanEducatorProfile | null;
}

/**
 * Validates + sanitises a draft save. `base` = the draft saved so far, else the live Store values, so a partial body
 * never blanks anything. Text is plain (tags removed). The same cleaners as the instant Store save are used, so a
 * draft can never hold something Publish would later refuse.
 */
export function cleanStorePageDraft(input: Record<string, any>, base: StorePageDraft): StorePageDraft {
  const next: StorePageDraft = { ...base };
  if (input.name !== undefined) {
    text(input.name, 'name', 120, true);
    next.name = cleanPlainText(input.name);
    if (!next.name) throw new BadRequestException('name is required');
  }
  if (input.tagline !== undefined) {
    if (input.tagline !== null) text(input.tagline, 'tagline', 160);
    next.tagline = input.tagline ? cleanPlainText(input.tagline) || null : null;
  }
  if (input.description !== undefined) {
    if (input.description !== null) text(input.description, 'description', 2000);
    next.description = input.description ? cleanPlainText(input.description) || null : null;
  }
  if (input.logo !== undefined) next.logo = httpsUrlOrNull(input.logo, 'logo');
  if (input.coverImage !== undefined) next.coverImage = httpsUrlOrNull(input.coverImage, 'coverImage');
  if (input.aboutBio !== undefined) next.aboutBio = cleanAboutBio(input.aboutBio);
  if (input.educatorProfile !== undefined) {
    next.educatorProfile = cleanEducatorProfile(input.educatorProfile, base.educatorProfile?.introVideoUrl);
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
  };
}
