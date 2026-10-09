/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AiService } from '../core/ai.service';

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const DECISIONS = ['approve', 'needs_changes', 'reject'] as const;

export const MODERATION_SCHEMA = {
  type: 'object',
  properties: {
    islamicSuitability: { type: 'string', enum: ['suitable', 'needs_review', 'unsuitable'] },
    ageSuitability: { type: 'string', enum: ['all_ages', 'teen_and_up', 'adult_only', 'unclear'] },
    copyrightRisk: { type: 'string', enum: [...RISK_LEVELS] },
    qualityIssues: { type: 'array', items: { type: 'string' } },
    suggestedDecision: { type: 'string', enum: [...DECISIONS] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
  required: ['islamicSuitability', 'ageSuitability', 'copyrightRisk', 'qualityIssues', 'suggestedDecision', 'reasons'],
  additionalProperties: false,
};

export interface ModerationResult {
  islamicSuitability: 'suitable' | 'needs_review' | 'unsuitable';
  ageSuitability: 'all_ages' | 'teen_and_up' | 'adult_only' | 'unclear';
  copyrightRisk: 'low' | 'medium' | 'high';
  qualityIssues: string[];
  suggestedDecision: 'approve' | 'needs_changes' | 'reject';
  reasons: string[];
}

/** Pure: coerce model output into the strict shape and keep the decision consistent with the risk flags (never softer than the flags). */
export function normalizeModeration(raw: any): ModerationResult {
  const pick = <T extends string>(v: any, allowed: readonly T[], dflt: T): T => (allowed.includes(v) ? v : dflt);
  const list = (v: any, n: number) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 240)).filter(Boolean).slice(0, n) : []);
  const r: ModerationResult = {
    islamicSuitability: pick(raw?.islamicSuitability, ['suitable', 'needs_review', 'unsuitable'] as const, 'needs_review'),
    ageSuitability: pick(raw?.ageSuitability, ['all_ages', 'teen_and_up', 'adult_only', 'unclear'] as const, 'unclear'),
    copyrightRisk: pick(raw?.copyrightRisk, RISK_LEVELS, 'medium'),
    qualityIssues: list(raw?.qualityIssues, 8),
    suggestedDecision: pick(raw?.suggestedDecision, DECISIONS, 'needs_changes'),
    reasons: list(raw?.reasons, 6),
  };
  if (r.islamicSuitability === 'unsuitable' || r.ageSuitability === 'adult_only') r.suggestedDecision = 'reject';
  else if (r.suggestedDecision === 'approve' && (r.islamicSuitability === 'needs_review' || r.copyrightRisk === 'high' || r.qualityIssues.length > 3)) r.suggestedDecision = 'needs_changes';
  return r;
}

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//i.test(u) && u.length < 1000;

@Injectable()
export class ModerationAiService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}

  /** Cached advisory result (if any). */
  async get(productId: string) {
    const p: any = await this.db.repositories.productModel.findOne({ _id: productId }).select('aiReview').lean();
    if (!p) throw new NotFoundException('Listing not found');
    return { success: true, data: p.aiReview ?? null };
  }

  /** Runs the AI pre-review and stores it on the listing. Advisory only: it never changes the listing status. */
  async review(productId: string, adminId: string) {
    const p: any = await this.db.repositories.productModel.findOne({ _id: productId, isDelete: false }).lean();
    if (!p) throw new NotFoundException('Listing not found');
    const category: any = p.categoryId ? await this.db.repositories.categoryModel.findById(p.categoryId).select('name').lean().catch(() => null) : null;

    const text = [
      `Title: ${p.name}`, `Type: ${p.productType}`, category?.name ? `Category: ${category.name}` : '',
      p.educationLevel ? `Education level: ${p.educationLevel}` : '',
      p.ageMin != null || p.ageMax != null ? `Ages: ${p.ageMin ?? '?'}-${p.ageMax ?? '?'}` : '',
      `Tags: ${(p.tags ?? []).join(', ')}`,
      `Description:\n${String(p.description ?? '').slice(0, 4000)}`,
      p.digital?.files?.length ? `Files: ${p.digital.files.slice(0, 10).map((f: any) => f.name).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const images = (p.images ?? []).filter(isHttps).slice(0, 3);
    const content: any[] = [
      ...images.map((url: string) => ({ type: 'image', source: { type: 'url', url } })),
      { type: 'text', text: `Review this listing submitted by a seller.\n<listing>\n${text}\n</listing>` },
    ];
    const r = await this.ai.generate({
      feature: 'moderation_review', tier: 'standard', adminId, maxTokens: 900, schema: MODERATION_SCHEMA,
      system: 'You pre-screen seller listings for an Islamic, education-only marketplace so a human admin can decide faster. Judge: (1) islamicSuitability: content must respect Islamic values (no shirk, mockery of religion, immodest imagery, music/dating/gambling promotion; flag unverifiable hadith/Quran claims as needs_review). (2) ageSuitability for children. (3) copyrightRisk: signs of pirated/scanned publisher books, brand logos or characters (Disney, Oxford, Cambridge, etc.), "free download of paid book". (4) qualityIssues: vague/empty description, misleading title, wrong category, low-quality or irrelevant images, missing grade/age. suggestedDecision: approve | needs_changes | reject. reasons: short, concrete, referencing what you saw. You only advise; the admin decides. Be conservative but fair; do not reject only for minor quality issues.',
      messages: [{ role: 'user', content }],
    });
    const result = normalizeModeration(r.json);
    const stored = { ...result, model: r.model, at: new Date().toISOString(), imagesChecked: images.length };
    await this.db.repositories.productModel.updateOne({ _id: productId }, { $set: { aiReview: stored } });
    return { success: true, data: stored };
  }
}
