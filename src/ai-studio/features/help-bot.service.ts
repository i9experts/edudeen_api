/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { AiService } from '../core/ai.service';

export interface FaqLite { question: string; answer: string; category?: string }

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'how', 'do', 'i', 'my', 'can', 'what', 'in', 'on', 'for', 'it', 'me', 'ka', 'ki', 'ke', 'kya', 'hai', 'kaise']);
const tokens = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !STOP.has(w));

/** Pure: rank FAQ entries by keyword overlap with the question; returns the best `n` with a positive score. */
export function rankFaqs(question: string, faqs: FaqLite[], n = 6): FaqLite[] {
  const q = new Set(tokens(question));
  if (!q.size) return [];
  return faqs
    .map((f) => {
      const qt = new Set(tokens(f.question)); const at = new Set(tokens(f.answer));
      let score = 0;
      for (const w of q) { if (qt.has(w)) score += 3; else if (at.has(w)) score += 1; }
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.f);
}

/** Seller help-bot grounded ONLY in the admin-managed FAQ content. */
@Injectable()
export class HelpBotService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}

  async ask(sellerId: string, storeId: string, question: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const q = String(question ?? '').trim().slice(0, 400);
    if (q.length < 3) throw new BadRequestException('Ask a question (at least 3 characters).');
    const faqs: any[] = await this.db.repositories.faqModel.find({ isActive: true }).select('question answer category').limit(300).lean();
    const top = rankFaqs(q, faqs.map((f) => ({ question: f.question, answer: f.answer, category: f.category })));
    if (!top.length) {
      return { success: true, data: { answer: 'I could not find this in the Edudeen help articles. Please contact Edudeen support from the Help page and we will assist you.', sources: [], grounded: false } };
    }
    const out = await this.ai.generate({
      feature: 'help_bot', tier: 'fast', storeId, sellerId, maxTokens: 500,
      system: 'You are Edudeen\'s seller help assistant. Answer the seller\'s question using ONLY the help articles provided. If they do not contain the answer, say you are not sure and suggest contacting support. Keep it short, step-by-step when useful. Reply in the seller\'s language (English, Urdu or Roman Urdu). Do not invent features, fees or policies.',
      messages: [{ role: 'user', content: `<articles>\n${top.map((f, i) => `[${i + 1}] Q: ${f.question}\nA: ${f.answer.slice(0, 1200)}`).join('\n\n')}\n</articles>\n\nSeller question: ${q}` }],
    });
    return { success: true, data: { answer: out.text.trim(), sources: top.map((f) => f.question), grounded: true } };
  }
}
