/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { COURSE_LIMITS, LESSON_TYPES, LessonType } from './schemas/course.schema';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => randomBytes(6).toString('hex');
const ID_RX = /^[a-f0-9]{12}$/;

export interface CleanLesson {
  _id: string;
  title: string;
  type: LessonType;
  file: { url: string; name: string; size: number | null; mimeType: string | null } | null;
  text: string;
  durationMinutes: number | null;
  isPreview: boolean;
  quiz: { passPercent: number; questions: { question: string; options: string[]; answerIndex: number }[] } | null;
}

/**
 * Validates the whole course structure the builder sends. File ownership is
 * checked by the caller (needs the uploads DB) via `fileRefs`. Lesson ids are
 * kept when valid so learners' progress survives edits.
 */
export function cleanCourseInput(body: any): { sections: { _id: string; title: string; lessons: CleanLesson[] }[]; certificateEnabled: boolean; fileRefs: { url: string; name: string }[] } {
  const rawSections = Array.isArray(body?.sections) ? body.sections : null;
  if (!rawSections) throw new BadRequestException('sections must be a list');
  if (rawSections.length > COURSE_LIMITS.sections) throw new BadRequestException(`A course can have up to ${COURSE_LIMITS.sections} sections`);
  const fileRefs: { url: string; name: string }[] = [];
  const seen = new Set<string>();
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
      if (!type) throw new BadRequestException(`"${lTitle}": pick video, PDF, text or quiz`);
      let file: CleanLesson['file'] = null;
      let quiz: CleanLesson['quiz'] = null;
      const text = str(l?.text, 20000);
      if (type === 'video' || type === 'pdf') {
        const url = str(l?.file?.url, 500);
        if (!url) throw new BadRequestException(`"${lTitle}": upload the ${type === 'video' ? 'video' : 'PDF'}`);
        const name = str(l?.file?.name, 255) || lTitle;
        file = { url, name, size: null, mimeType: null };
        fileRefs.push({ url, name });
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
        _id: keepId(l?._id), title: lTitle, type, file, text: type === 'text' ? text : str(l?.text, 2000), quiz,
        durationMinutes: dur != null && Number.isFinite(dur) && dur > 0 ? Math.min(Math.round(dur), 1000) : null,
        isPreview: l?.isPreview === true && type !== 'quiz',
      };
    });
    return { _id: keepId(s?._id), title, lessons };
  });
  return { sections, certificateEnabled: body?.certificateEnabled !== false, fileRefs };
}

/** Scores a quiz attempt. `answers[i]` is the option index chosen for question i. */
export function scoreQuiz(quiz: NonNullable<CleanLesson['quiz']>, answers: unknown) {
  const list = Array.isArray(answers) ? answers : [];
  const correct = quiz.questions.reduce((n, q, i) => n + (Number(list[i]) === q.answerIndex ? 1 : 0), 0);
  const percent = quiz.questions.length ? Math.round((correct / quiz.questions.length) * 100) : 0;
  return { correct, total: quiz.questions.length, percent, passed: percent >= quiz.passPercent };
}

export const lessonIds = (sections: { lessons: { _id: string }[] }[]) => sections.flatMap(s => s.lessons.map(l => l._id));

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
