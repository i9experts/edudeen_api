/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AUDIO_EXTENSIONS, CertificateConfig, CertificateDetails, COURSE_LIMITS, LESSON_TYPES, LessonSubtitle, LessonType, SUBTITLE_LANGS, SUBTITLE_LIMITS } from './schemas/course.schema';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => randomBytes(6).toString('hex');
const ID_RX = /^[a-f0-9]{12}$/;

export interface CleanLesson {
  _id: string;
  title: string;
  type: LessonType;
  file: { url: string; name: string; size: number | null; mimeType: string | null } | null;
  videoUrl: string | null;
  subtitles: LessonSubtitle[];
  text: string;
  durationMinutes: number | null;
  isPreview: boolean;
  quiz: { passPercent: number; questions: { question: string; options: string[]; answerIndex: number }[] } | null;
}

/**
 * Subtitles of one video / voice lesson: at most one per language (Urdu or English). The builder sends WebVTT
 * (it converts .srt itself) or a plain transcript; empty entries are dropped. `kind` is decided here, from the content.
 */
export function cleanSubtitles(raw: unknown, lessonTitle: string): LessonSubtitle[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException(`"${lessonTitle}": subtitles must be a list`);
  const seen = new Set<string>();
  const out: LessonSubtitle[] = [];
  for (const s of raw as any[]) {
    const lang = s?.lang;
    if (!(SUBTITLE_LANGS as readonly string[]).includes(lang)) throw new BadRequestException(`"${lessonTitle}": subtitles can be in Urdu, Roman Urdu or English`);
    if (seen.has(lang)) throw new BadRequestException(`"${lessonTitle}": add only one subtitle per language`);
    seen.add(lang);
    const content = typeof s?.content === 'string' ? s.content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim() : '';
    if (!content) continue;
    if (content.length > SUBTITLE_LIMITS.perTrack) throw new BadRequestException(`"${lessonTitle}": the ${lang === 'ur' ? 'Urdu' : 'English'} subtitles are too long (max ${SUBTITLE_LIMITS.perTrack.toLocaleString('en-US')} characters)`);
    out.push({ lang, kind: /^WEBVTT/.test(content) ? 'timed' : 'text', content });
  }
  return out;
}

export const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com'] as const;

/** An external lesson video: https on YouTube / Vimeo only (watch, embed or unlisted links). Returns the cleaned URL or null. */
export function cleanVideoUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const raw = v.trim();
  if (raw.length > 300) throw new BadRequestException('The video link is too long');
  let u: URL;
  try { u = new URL(raw); } catch { throw new BadRequestException('Paste a valid YouTube or Vimeo link'); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  const ok = (VIDEO_HOSTS as readonly string[]).some(h => host === h || host.endsWith(`.${h}`));
  if (u.protocol !== 'https:' || !ok || u.username || u.password) throw new BadRequestException('Only https YouTube or Vimeo links are allowed');
  return u.toString();
}

export function cleanCourseExtras(body: any): { outcomes: string[]; instructor: { name: string; bio: string }; accessDays: number | null } {
  const rawOutcomes = body?.outcomes === undefined || body?.outcomes === null ? [] : body.outcomes;
  if (!Array.isArray(rawOutcomes)) throw new BadRequestException('outcomes must be a list');
  if (rawOutcomes.length > 10) throw new BadRequestException('Add up to 10 learning outcomes');
  const outcomes = rawOutcomes.map((o: unknown) => {
    if (typeof o !== 'string') throw new BadRequestException('Each outcome must be text');
    const t = o.trim();
    if (t.length > 200) throw new BadRequestException('An outcome can be up to 200 characters');
    return t;
  }).filter(Boolean);
  const inst = body?.instructor && typeof body.instructor === 'object' ? body.instructor : {};
  const name = typeof inst.name === 'string' ? inst.name.trim() : '';
  const bio = typeof inst.bio === 'string' ? inst.bio.trim() : '';
  if (name.length > 100) throw new BadRequestException('Instructor name can be up to 100 characters');
  if (bio.length > 1000) throw new BadRequestException('Instructor bio can be up to 1000 characters');
  let accessDays: number | null = null;
  if (body?.accessDays !== undefined && body.accessDays !== null && body.accessDays !== '') {
    accessDays = Number(body.accessDays);
    if (!Number.isInteger(accessDays) || accessDays < 1 || accessDays > 3650) throw new BadRequestException('Access duration must be 1-3650 days (or lifetime)');
  }
  return { outcomes, instructor: { name, bio }, accessDays };
}

export const EMPTY_CERT_CONFIG: CertificateConfig = { watermarkText: null, watermarkImageUrl: null, stampImageUrl: null, signatureName: null, signatureTitle: null, issuerName: null };

/** Hosts a public certificate image may come from (the Cloudinary public store + optional env `PUBLIC_ASSET_HOSTS`, comma list). */
function allowedImageHosts(): string[] {
  const extra = (process.env.PUBLIC_ASSET_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return ['res.cloudinary.com', ...extra];
}

function certText(v: unknown, max: number, label: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestException(`${label} must be text`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new BadRequestException(`${label} can be up to ${max} characters`);
  if (/[<>]/.test(t)) throw new BadRequestException(`${label} cannot contain < or >`);
  return t;
}

function certImage(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestException(`${label} must be a link`);
  const raw = v.trim();
  if (raw.length > 500) throw new BadRequestException(`${label} link is too long`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new BadRequestException(`${label} must be a valid https link`); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !allowedImageHosts().includes(host)) {
    throw new BadRequestException(`${label} must be an image you uploaded through Edudeen`);
  }
  return u.toString();
}

/** Validates the seller's certificate look. `null` clears everything. Throws on bad input. */
export function cleanCertificateConfig(raw: unknown): CertificateConfig {
  if (raw === null) return { ...EMPTY_CERT_CONFIG };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('certificateConfig must be an object');
  const c = raw as Record<string, unknown>;
  const signatureImageUrl = certImage(c.signatureImageUrl, 'Signature image');
  const logoImageUrl = certImage(c.logoImageUrl, 'Logo image');
  return {
    ...(logoImageUrl ? { logoImageUrl } : {}),
    watermarkText: certText(c.watermarkText, 40, 'Watermark text'),
    watermarkImageUrl: certImage(c.watermarkImageUrl, 'Watermark image'),
    stampImageUrl: certImage(c.stampImageUrl, 'Stamp image'),
    signatureName: certText(c.signatureName, 80, 'Signature name'),
    signatureTitle: certText(c.signatureTitle, 80, 'Signature title'),
    ...(signatureImageUrl ? { signatureImageUrl } : {}),
    issuerName: certText(c.issuerName, 80, 'Issuer name'),
  };
}

/** The learner's certificate form. fullName is required (2-80); the rest are optional. */
export function cleanCertificateDetails(raw: any): CertificateDetails {
  if (!raw || typeof raw !== 'object') throw new BadRequestException('Send your certificate details');
  const fullName = certText(raw.fullName, 80, 'Full name');
  if (!fullName || fullName.length < 2) throw new BadRequestException('Full name must be 2-80 characters');
  return {
    fullName,
    guardianName: certText(raw.guardianName, 80, 'Parent / guardian name'),
    gender: raw.gender === 'male' || raw.gender === 'female' ? raw.gender : null,
    institute: certText(raw.institute, 120, 'School / institute'),
    city: certText(raw.city, 60, 'City'),
    country: certText(raw.country, 60, 'Country'),
  };
}

export function courseTotals(sections: { lessons: { durationMinutes?: number | null }[] }[] | undefined) {
  const list = sections ?? [];
  return {
    lessonCount: list.reduce((n, s) => n + (s.lessons?.length ?? 0), 0),
    totalMinutes: list.reduce((n, s) => n + (s.lessons ?? []).reduce((m, l) => m + (l.durationMinutes ?? 0), 0), 0),
  };
}

export type AccessDaysEntry = { from: Date | string; days: number | null };

/**
 * The access length that applied on `boughtAt`. The log lists "from <date>, access is <days>"; the entry in force on
 * the purchase day wins, so a seller changing the length later only affects NEW buyers. No log = the current value.
 */
export function accessDaysAt(course: { accessDays?: number | null; accessDaysLog?: AccessDaysEntry[] | null } | null | undefined, boughtAt: Date | string | null | undefined): number | null {
  const log = course?.accessDaysLog;
  if (!log?.length || !boughtAt) return course?.accessDays ?? null;
  const t = new Date(boughtAt).getTime();
  let days: number | null | undefined;
  let best = -Infinity;
  for (const e of log) {
    const from = new Date(e.from).getTime();
    if (from <= t && from >= best) { best = from; days = e.days; }
  }
  return days === undefined ? (course?.accessDays ?? null) : days;
}

/** The log to store when the seller saves `newDays`; null = nothing changed (leave the stored log alone). */
export function nextAccessDaysLog(existing: { accessDays?: number | null; accessDaysLog?: AccessDaysEntry[] | null } | null | undefined, newDays: number | null, now = new Date()): AccessDaysEntry[] | null {
  const current = existing?.accessDays ?? null;
  if (existing && current === newDays) return null;
  const log: AccessDaysEntry[] = (existing?.accessDaysLog ?? []).map(e => ({ from: e.from, days: e.days }));
  // First change on a course that has sold before: everything bought until now keeps the old length.
  if (existing && !log.length) log.push({ from: new Date(0), days: current });
  log.push({ from: now, days: newDays });
  return log;
}

/** The date a purchased course stops being available, or null for lifetime access. */
export function accessExpiry(paidAt: Date | string | null | undefined, accessDays: number | null | undefined): Date | null {
  if (!accessDays || !paidAt) return null;
  return new Date(new Date(paidAt).getTime() + accessDays * 86400000);
}

/**
 * Validates the whole course structure the builder sends. File ownership is
 * checked by the caller (needs the uploads DB) via `fileRefs`. Lesson ids are
 * kept when valid so learners' progress survives edits.
 */
export function cleanCourseInput(body: any): { sections: { _id: string; title: string; lessons: CleanLesson[] }[]; certificateEnabled: boolean; fileRefs: { url: string; name: string }[]; outcomes: string[]; instructor: { name: string; bio: string }; accessDays: number | null } {
  const rawSections = Array.isArray(body?.sections) ? body.sections : null;
  if (!rawSections) throw new BadRequestException('sections must be a list');
  if (rawSections.length > COURSE_LIMITS.sections) throw new BadRequestException(`A course can have up to ${COURSE_LIMITS.sections} sections`);
  const fileRefs: { url: string; name: string }[] = [];
  const seen = new Set<string>();
  let subtitleChars = 0;
  const keepId = (v: unknown) => {
    const id = typeof v === 'string' && ID_RX.test(v) && !seen.has(v) ? v : newId();
    seen.add(id);
    return id;
  };

  const sections = rawSections.map((s: any, si: number) => {
    const title = str(s?.title, 120) || `Section ${si + 1}`;
    const rawLessons = Array.isArray(s?.lessons) ? s.lessons : [];
    if (rawLessons.length > COURSE_LIMITS.lessonsPerSection) throw new BadRequestException(`"${title}" has too many lessons (max ${COURSE_LIMITS.lessonsPerSection})`);
    const lessons: CleanLesson[] = rawLessons.map((l: any, li: number) => {
      const lTitle = str(l?.title, 150);
      if (!lTitle) throw new BadRequestException(`Lesson ${li + 1} in "${title}" needs a title`);
      const type = (LESSON_TYPES as readonly string[]).includes(l?.type) ? (l.type as LessonType) : null;
      if (!type) throw new BadRequestException(`"${lTitle}": pick video, voice, PDF, text or quiz`);
      let file: CleanLesson['file'] = null;
      let quiz: CleanLesson['quiz'] = null;
      let videoUrl: string | null = null;
      const text = str(l?.text, 20000);
      const subtitles = type === 'video' || type === 'audio' ? cleanSubtitles(l?.subtitles, lTitle) : [];
      subtitleChars += subtitles.reduce((n, s) => n + s.content.length, 0);
      if (subtitleChars > SUBTITLE_LIMITS.perCourse) throw new BadRequestException('The subtitles in this course are too large in total. Shorten or remove some of them.');
      if (type === 'video' || type === 'pdf' || type === 'audio') {
        const url = str(l?.file?.url, 500);
        if (type === 'video') videoUrl = cleanVideoUrl(l?.videoUrl);
        if (!url && !videoUrl) throw new BadRequestException(`"${lTitle}": upload the ${type === 'video' ? 'video or paste a YouTube/Vimeo link' : type === 'audio' ? 'voice recording (MP3, M4A, WAV or OGG)' : 'PDF'}`);
        if (url && type === 'audio') {
          const ext = (str(l?.file?.name, 255).split('.').pop() ?? '').toLowerCase();
          if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) throw new BadRequestException(`"${lTitle}": the voice recording must be an MP3, M4A, WAV or OGG file`);
        }
        if (url) {
          const name = str(l?.file?.name, 255) || lTitle;
          file = { url, name, size: null, mimeType: null };
          fileRefs.push({ url, name });
        }
      } else if (type === 'text') {
        if (text.length < 1) throw new BadRequestException(`"${lTitle}": write the lesson text`);
      } else {
        const qs = Array.isArray(l?.quiz?.questions) ? l.quiz.questions : [];
        if (!qs.length) throw new BadRequestException(`"${lTitle}": add at least one question`);
        if (qs.length > COURSE_LIMITS.quizQuestions) throw new BadRequestException(`"${lTitle}": up to ${COURSE_LIMITS.quizQuestions} questions`);
        const questions = qs.map((q: any, qi: number) => {
          const question = str(q?.question, 500);
          const options = (Array.isArray(q?.options) ? q.options : []).map((o: unknown) => str(o, 200)).filter(Boolean);
          const answerIndex = Number(q?.answerIndex);
          if (!question) throw new BadRequestException(`"${lTitle}": question ${qi + 1} is empty`);
          if (options.length < 2 || options.length > COURSE_LIMITS.options) throw new BadRequestException(`"${lTitle}": question ${qi + 1} needs 2–${COURSE_LIMITS.options} options`);
          if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) throw new BadRequestException(`"${lTitle}": mark the correct answer for question ${qi + 1}`);
          return { question, options, answerIndex };
        });
        const pass = Number(l?.quiz?.passPercent ?? 60);
        quiz = { passPercent: Number.isFinite(pass) ? Math.max(0, Math.min(100, Math.round(pass))) : 60, questions };
      }
      const dur = l?.durationMinutes == null || l.durationMinutes === '' ? null : Number(l.durationMinutes);
      return {
        _id: keepId(l?._id), title: lTitle, type, file, videoUrl, subtitles, text: type === 'text' ? text : str(l?.text, 2000), quiz,
        durationMinutes: dur != null && Number.isFinite(dur) && dur > 0 ? Math.min(Math.max(Math.round(dur * 100) / 100, 0.01), 1000) : null,
        isPreview: l?.isPreview === true && type !== 'quiz',
      };
    });
    return { _id: keepId(s?._id), title, lessons };
  });
  return { sections, certificateEnabled: body?.certificateEnabled !== false, fileRefs, ...cleanCourseExtras(body) };
}

/** Scores a quiz attempt. `answers[i]` is the option index chosen for question i. */
export function scoreQuiz(quiz: NonNullable<CleanLesson['quiz']>, answers: unknown) {
  const list = Array.isArray(answers) ? answers : [];
  const correct = quiz.questions.reduce((n, q, i) => n + (Number(list[i]) === q.answerIndex ? 1 : 0), 0);
  const percent = quiz.questions.length ? Math.round((correct / quiz.questions.length) * 100) : 0;
  return { correct, total: quiz.questions.length, percent, passed: percent >= quiz.passPercent };
}

export const lessonIds = (sections: { lessons: { _id: string }[] }[]) => sections.flatMap(s => s.lessons.map(l => l._id));

// ── Audio / video completion: the learner must really have played >= 90% of the lesson ─────────────────────────────
export const PLAY_REQUIRED_RATIO = 0.9;
/** Largest chunk of played time one report may claim. */
export const PLAY_MAX_DELTA_S = 30;
export interface PlayedEntry { seconds: number; durationSeconds: number | null; lastAt: Date | string | null }

/** Seconds that count as "the whole lesson". The teacher's length (minutes, coarse) wins, but a shorter real media length is
 *  accepted down to half of it (minutes are rounded up); a lesson with no teacher length uses the player's own report. */
export function lessonLengthSeconds(durationMinutes: number | null | undefined, reportedSeconds: number | null | undefined): number | null {
  const declared = typeof durationMinutes === 'number' && durationMinutes > 0 ? durationMinutes * 60 : null;
  const reported = typeof reportedSeconds === 'number' && Number.isFinite(reportedSeconds) && reportedSeconds >= 10 ? reportedSeconds : null;
  if (declared && reported) return reported >= declared * 0.5 ? Math.min(declared, reported) : declared;
  return declared ?? reported;
}

/** New played total after a report of `delta` seconds: the credit can never exceed the real time since the previous report. */
export function creditPlayed(prev: PlayedEntry | undefined, delta: number, nowMs: number): number {
  const d = Math.min(PLAY_MAX_DELTA_S, Math.max(0, Number.isFinite(delta) ? delta : 0));
  const last = prev?.lastAt ? new Date(prev.lastAt).getTime() : null;
  // First report: no earlier timestamp to compare with, so at most 15 s. Later: never more than the real time since the last one (+2 s slack).
  return (prev?.seconds ?? 0) + (last ? Math.min(d, Math.max(0, (nowMs - last) / 1000) + 2) : Math.min(d, 15));
}

/** True when the credited time reaches the required share. Unknown length = not enough (the player must report one). */
export function playedEnough(entry: PlayedEntry | undefined, durationMinutes: number | null | undefined): boolean {
  const len = lessonLengthSeconds(durationMinutes, entry?.durationSeconds);
  return !!entry && len !== null && entry.seconds >= len * PLAY_REQUIRED_RATIO;
}

export function certificateCode() {
  return `EDU-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Orders that hold a seat in a live class (paid, not cancelled/refunded) — shared by checkout and the seats counter. */
export function paidSeatFilter(productId: string) {
  return {
    isDelete: false, isPaid: true,
    sellerOrders: { $elemMatch: { items: { $elemMatch: { productId, status: { $nin: ['cancelled', 'refunded'] } } } } },
  };
}
