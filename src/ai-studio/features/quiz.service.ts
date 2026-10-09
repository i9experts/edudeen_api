/* eslint-disable prettier/prettier */
import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { ProductsService } from '../../products/products.service';
import { UploadService } from '../../upload/upload.service';
import { UploadedAssetsService } from '../../upload/uploaded-assets.service';
import { cleanAiText } from '../ai-output.util';
import { AiService } from '../core/ai.service';
import { TtsService } from '../providers/tts.service';
import { renderWorksheetHtml, WorksheetOut } from './studio-extras.service';

// ------------------------------------------------------------------ shared sheet shape (worksheet + quiz)

export type SheetQuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'fill_in_blank' | 'open_ended';
export interface SheetQuestion { type: SheetQuestionType; prompt: string; choices?: string[]; answer?: string; explanation?: string }
export interface SheetSection { instructions?: string; questions: SheetQuestion[] }
export interface Sheet { title: string; sections: SheetSection[] }
export interface Quiz extends Sheet { language: 'en' | 'ur'; grade?: string }

const TYPES: SheetQuestionType[] = ['multiple_choice', 'true_false', 'short_answer', 'fill_in_blank', 'open_ended'];
const MAX_QUESTIONS = 40;

export const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instructions: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['multiple_choice', 'true_false', 'short_answer'] },
                prompt: { type: 'string' },
                choices: { type: 'array', items: { type: 'string' }, description: 'Only for multiple_choice: 3-4 options WITHOUT letters' },
                answer: { type: 'string', description: 'multiple_choice: the exact text of the correct option. true_false: True or False. short_answer: a model answer.' },
                explanation: { type: 'string', description: 'One short sentence' },
              },
              required: ['type', 'prompt', 'answer'],
              additionalProperties: false,
            },
          },
        },
        required: ['instructions', 'questions'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'sections'],
  additionalProperties: false,
};

const URDU_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
export const hasUrdu = (s: string) => URDU_RE.test(s);

/** Pure: reduce untrusted/edited sheet content (AI output or the seller's edits) to the strict, bounded shape. Throws 400 when nothing usable is left. */
export function normalizeSheet(raw: any, fallbackTitle = 'Worksheet'): Sheet {
  if (!raw || typeof raw !== 'object') throw new BadRequestException('Nothing to export');
  let total = 0;
  const sections: SheetSection[] = [];
  for (const s of Array.isArray(raw.sections) ? raw.sections.slice(0, 12) : []) {
    const questions: SheetQuestion[] = [];
    for (const q of Array.isArray(s?.questions) ? s.questions : []) {
      if (total >= MAX_QUESTIONS) break;
      const prompt = cleanAiText(q?.prompt, 600);
      if (!prompt) continue;
      // Worksheets use "multiple_choice"; accept the common short aliases too.
      const alias: Record<string, SheetQuestionType> = { mcq: 'multiple_choice', truefalse: 'true_false', short: 'short_answer' };
      const t0 = String(q?.type ?? '').toLowerCase();
      let type: SheetQuestionType = TYPES.includes(t0 as SheetQuestionType) ? (t0 as SheetQuestionType) : alias[t0] ?? 'short_answer';
      const choices = Array.isArray(q?.choices) ? q.choices.map((c: unknown) => cleanAiText(c, 200)).filter((c: string | null): c is string => !!c).slice(0, 6) : [];
      if (type === 'multiple_choice' && choices.length < 2) type = 'short_answer';
      questions.push({
        type, prompt, ...(type === 'multiple_choice' ? { choices } : {}),
        ...(cleanAiText(q?.answer, 600) ? { answer: cleanAiText(q.answer, 600)! } : {}),
        ...(cleanAiText(q?.explanation, 300) ? { explanation: cleanAiText(q.explanation, 300)! } : {}),
      });
      total++;
    }
    if (questions.length) sections.push({ ...(cleanAiText(s?.instructions, 400) ? { instructions: cleanAiText(s.instructions, 400)! } : {}), questions });
  }
  if (!sections.length) throw new BadRequestException('There are no questions to export');
  return { title: cleanAiText(raw.title, 120) ?? fallbackTitle, sections };
}

export function normalizeQuiz(raw: any, language: 'en' | 'ur', grade?: string): Quiz {
  return { ...normalizeSheet(raw, 'Quiz'), language, ...(grade ? { grade: grade.slice(0, 40) } : {}) };
}

export function sheetHasUrdu(sheet: Sheet): boolean {
  return hasUrdu(JSON.stringify(sheet));
}

// ------------------------------------------------------------------ PDF (pdf-lib, built-in Latin font)

/** pdf-lib's standard fonts are WinAnsi only: map common punctuation, replace the rest. (Urdu is refused before this is called.) */
export function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[   ]/g, ' ')
    .replace(/•/g, '*').replace(/[\r\t]/g, ' ')
    .replace(/[^\n\x20-\x7E¡-ÿ]/g, '?');
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of toWinAnsi(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) { cur = next; continue; }
      if (cur) out.push(cur);
      // a single very long word: hard-split it
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > maxWidth) n--;
        out.push(w.slice(0, n)); w = w.slice(n);
      }
      cur = w;
    }
    out.push(cur);
  }
  return out;
}

/** Latin-only printable PDF of a worksheet/quiz. Throws a 422 for Urdu content (no shaping-capable font is available server-side). */
export async function renderSheetPdf(sheet: Sheet, opts: { includeAnswers?: boolean; brand?: string } = {}): Promise<Uint8Array> {
  if (sheetHasUrdu(sheet)) {
    throw new HttpException({ success: false, errorCode: 'PDF_URDU_UNSUPPORTED', message: 'PDF export supports English only. For Urdu, open the printable page and use Print / Save as PDF in your browser.' }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const W = 595.28; const H = 841.89; const M = 54; const maxW = W - 2 * M;
  let page = pdf.addPage([W, H]); let y = H - M;
  const ink = rgb(0.08, 0.08, 0.07); const grey = rgb(0.4, 0.4, 0.4);
  const room = (h: number) => { if (y - h < M + 20) { page = pdf.addPage([W, H]); y = H - M; } };
  const text = (t: string, o: { f?: PDFFont; size?: number; indent?: number; color?: any; gap?: number } = {}) => {
    const f = o.f ?? font; const size = o.size ?? 11; const indent = o.indent ?? 0; const lh = size * 1.35;
    for (const line of wrapLine(t, f, size, maxW - indent)) {
      room(lh); page.drawText(line, { x: M + indent, y: y - size, size, font: f, color: o.color ?? ink }); y -= lh;
    }
    y -= o.gap ?? 0;
  };
  const rule = (gap = 14) => { room(gap + 2); page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) }); y -= gap; };

  text(sheet.title, { f: bold, size: 20, gap: 6 });
  rule(10);
  text('Name: ______________________________        Date: ________________', { size: 10, color: grey, gap: 10 });

  let n = 0;
  for (const s of sheet.sections) {
    if (s.instructions) text(s.instructions, { f: ital, size: 10.5, color: grey, gap: 6 });
    for (const q of s.questions) {
      n++;
      room(40);
      text(`${n}. ${q.prompt}`, { f: bold, size: 11, gap: 3 });
      if (q.type === 'multiple_choice' && q.choices?.length) {
        q.choices.forEach((c, i) => text(`${String.fromCharCode(65 + i)}) ${c}`, { indent: 18, gap: 1 }));
      } else if (q.type === 'true_false') {
        text('True  /  False', { indent: 18 });
      } else {
        for (let i = 0; i < 2; i++) { room(22); y -= 18; page.drawLine({ start: { x: M + 18, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.65, 0.65, 0.65) }); }
        y -= 4;
      }
      y -= 8;
    }
  }
  if (opts.includeAnswers) {
    page = pdf.addPage([W, H]); y = H - M;
    text('Answer key', { f: bold, size: 16, gap: 8 });
    let k = 0;
    for (const s of sheet.sections) for (const q of s.questions) {
      k++;
      text(`${k}. ${q.answer ?? '-'}${q.explanation ? `  (${q.explanation})` : ''}`, { size: 10.5, gap: 2 });
    }
  }
  const brand = toWinAnsi(opts.brand ?? 'Made with Edudeen AI Studio');
  pdf.getPages().forEach((p, i, all) => {
    p.drawText(`${brand}  -  page ${i + 1} of ${all.length}`, { x: M, y: 28, size: 8, font, color: rgb(0.55, 0.55, 0.55) });
  });
  return pdf.save();
}

// ------------------------------------------------------------------ service

export interface QuizDto { sourceText?: string; productId?: string; grade?: string; language?: 'en' | 'ur'; mcq?: number; trueFalse?: number; short?: number; title?: string }
export interface SaveSheetDto { generationId?: string; content?: unknown; title?: string; includeAnswers?: boolean }

const clampInt = (v: unknown, def: number, max: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : def; };

@Injectable()
export class QuizService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ai: AiService,
    private readonly tts: TtsService,
    private readonly uploads: UploadService,
    private readonly uploadedAssets: UploadedAssetsService,
    private readonly products: ProductsService,
  ) {}
  private get r() { return this.db.repositories; }

  async generate(sellerId: string, storeId: string, dto: QuizDto) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const language: 'en' | 'ur' = dto.language === 'ur' ? 'ur' : 'en';
    const mcq = clampInt(dto.mcq, 5, 15); const tf = clampInt(dto.trueFalse, 3, 10); const short = clampInt(dto.short, 2, 10);
    if (mcq + tf + short < 1) throw new BadRequestException('Ask for at least one question');
    let source = String(dto.sourceText ?? '').trim().slice(0, 6000);
    let sourceTitle = '';
    if (dto.productId) {
      if (!Types.ObjectId.isValid(dto.productId)) throw new BadRequestException('Invalid product');
      const p: any = await this.r.productModel.findOne({ _id: dto.productId, storeId, isDelete: false }).select('name description').lean();
      if (!p) throw new NotFoundException('Product not found in this store');
      sourceTitle = p.name; source = source || String(p.description ?? '').replace(/<[^>]*>/g, ' ').slice(0, 6000);
    }
    if (source.length < 40) throw new BadRequestException('Paste some lesson text (at least a few sentences) or pick a product with a description.');

    const grade = cleanAiText(dto.grade, 40) ?? undefined;
    const quiz = await this.ai.withCredits('quiz_generator', storeId, sellerId, async () => {
      const out = await this.ai.generate({
        feature: 'quiz_generator', tier: 'standard', storeId, sellerId, maxTokens: 3500, schema: QUIZ_SCHEMA,
        system: `You write classroom quizzes for teachers on an education marketplace. Use ONLY the supplied lesson text; never add facts that are not in it. Write the quiz in ${language === 'ur' ? 'Urdu (Urdu script)' : 'English'}. Produce exactly ${mcq} multiple_choice (3-4 options each, one correct, "answer" must equal one option verbatim), ${tf} true_false ("answer" is exactly the English word True or False) and ${short} short_answer questions. Put each type in its own section with a one-line instruction. Keep the difficulty suitable for ${grade ?? 'the stated lesson level'}. The seller will review and edit before use.`,
        messages: [{ role: 'user', content: `${grade ? `Grade/level: ${grade}\n` : ''}${dto.title ? `Quiz title: ${dto.title}\n` : sourceTitle ? `Topic: ${sourceTitle}\n` : ''}Lesson text:\n${source}` }],
      });
      return normalizeQuiz(out.json, language, grade);
    });
    if (dto.title && cleanAiText(dto.title, 120)) quiz.title = cleanAiText(dto.title, 120)!;
    const row: any = await this.r.aiGenerationModel.create({
      scope: 'seller', sellerId, storeId, toolType: 'quiz_generator', status: 'succeeded', productId: dto.productId ?? null,
      inputPayload: { grade, language, mcq, trueFalse: tf, short, fromProduct: !!dto.productId }, outputPayload: quiz,
      providerUsed: 'claude', creditsCharged: this.ai['credits']?.costOf('quiz_generator') ?? 0, sessionId: new Types.ObjectId().toString(), isCallLog: false,
    }).catch(() => null);
    return { success: true, data: { generationId: row?._id?.toString() ?? null, quiz, creditsCharged: this.ai['credits']?.costOf('quiz_generator') ?? 0 } };
  }

  /** Printable HTML of the (possibly edited) quiz. No AI call, no credits; content is re-validated. Also used for Urdu "Print / Save as PDF". */
  async html(sellerId: string, storeId: string, content: unknown, includeAnswers: boolean) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const sheet = normalizeSheet(content, 'Quiz');
    return { success: true, data: { html: renderWorksheetHtml(sheet as unknown as WorksheetOut, { includeAnswers }), title: sheet.title } };
  }

  /** Server-side audio is an optional adapter (see providers/tts.service.ts). Disabled -> clean 503; the UI uses browser SpeechSynthesis. */
  async audio(sellerId: string, storeId: string, text: string, lang: 'en' | 'ur') {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const r = await this.tts.synthesize({ text: String(text ?? '').slice(0, 5000), lang });
    return { success: true, data: { mimeType: r.mimeType, base64: r.audio.toString('base64') } };
  }

  /**
   * "Save as digital product (draft)": PDF of a generated worksheet/quiz -> private upload -> DRAFT digital product at price 0
   * in the seller's store (flagged aiGenerated). Uses the normal product creation service, so plan limits, store checks and
   * validation all apply. The seller reviews, sets a price and publishes manually. No AI call -> no extra credits.
   */
  async saveAsDraftProduct(sellerId: string, storeId: string, dto: SaveSheetDto) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    let raw: unknown = dto.content;
    if (!raw) {
      if (!dto.generationId || !Types.ObjectId.isValid(dto.generationId)) throw new BadRequestException('Provide generationId or content');
      const g: any = await this.r.aiGenerationModel.findOne({ _id: dto.generationId, storeId, toolType: { $in: ['worksheet_builder', 'quiz_generator'] }, status: 'succeeded' }).lean();
      if (!g?.outputPayload) throw new NotFoundException('Generation not found');
      raw = g.outputPayload;
    }
    const sheet = normalizeSheet(raw, 'Worksheet');
    const title = cleanAiText(dto.title, 120) ?? sheet.title;
    const pdfBytes = await renderSheetPdf({ ...sheet, title }, { includeAnswers: !!dto.includeAnswers });

    const fileName = `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'worksheet'}.pdf`;
    const buffer = Buffer.from(pdfBytes);
    const up = await this.uploads.uploadPrivateFile({ buffer, originalname: fileName, mimetype: 'application/pdf', size: buffer.length } as Express.Multer.File);
    await this.uploadedAssets.record({ publicId: up.publicId, ownerId: sellerId, ownerRole: 'seller', kind: 'digital_product', resourceType: up.resourceType, fileName: up.fileName, fileSize: up.fileSize, mimeType: up.mimeType });

    const created: any = await this.products.addDigitalProduct(sellerId, {
      storeId, name: title.slice(0, 200), productType: 'digital', price: 0, status: 'draft',
      description: `${title}. Printable ${sheet.sections.reduce((n, s) => n + s.questions.length, 0)}-question sheet created with AI Studio. Review the content, add a price and a description, then publish.`,
      digital: { files: [{ url: up.publicId, name: fileName }] },
    });
    const productId = created?.data?.product?._id?.toString();
    if (productId) await this.r.productModel.updateOne({ _id: productId }, { $set: { aiGenerated: true } });
    return { success: true, message: 'Saved as a draft product. Review it and publish when you are ready.', data: { productId, name: title, status: 'draft', price: 0 } };
  }
}
