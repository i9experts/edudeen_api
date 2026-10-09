/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { cleanAiText } from '../ai-output.util';
import { AiService } from '../core/ai.service';

export type TranslateDirection = 'en_to_ur' | 'ur_to_en';

export const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    needsReview: { type: 'array', items: { type: 'string' }, description: 'Short notes about religious quotes/rulings or unclear terms that a human must verify.' },
  },
  required: ['title', 'description', 'needsReview'],
  additionalProperties: false,
};

/** Pure: does the text contain Urdu/Arabic script? */
export function hasUrduScript(s: string): boolean { return /[؀-ۿ]/.test(s || ''); }

/** Pure: which direction fits this text (used when the client does not say). */
export function detectDirection(title: string, description = ''): TranslateDirection {
  return hasUrduScript(`${title} ${description}`) ? 'ur_to_en' : 'en_to_ur';
}

@Injectable()
export class TranslateService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}

  private async verify(storeId: string, sellerId: string) {
    return verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
  }

  /** Draft translation of arbitrary text (product form before saving). Nothing is stored. */
  async translateText(sellerId: string, storeId: string, body: { title: string; description?: string; direction?: TranslateDirection }) {
    await this.verify(storeId, sellerId);
    const title = String(body.title ?? '').trim().slice(0, 300);
    const description = String(body.description ?? '').trim().slice(0, 6000);
    if (!title) throw new BadRequestException('title is required');
    const direction = body.direction ?? detectDirection(title, description);
    const out = await this.run(sellerId, storeId, title, description, direction);
    return { success: true, data: { direction, ...out } };
  }

  /** Translate a saved product to Urdu. save=false (single product, form) returns a DRAFT the seller edits then saves via saveUrdu(). */
  async translateProduct(sellerId: string, storeId: string, productId: string, save = false) {
    await this.verify(storeId, sellerId);
    const p: any = await this.db.repositories.productModel.findOne({ _id: productId, storeId, isDelete: false });
    if (!p) throw new NotFoundException('Product not found in this store');
    const out = await this.run(sellerId, storeId, p.name, p.description ?? '', 'en_to_ur');
    if (save) await this.db.repositories.productModel.updateOne({ _id: p._id }, { $set: { nameUr: out.title, descriptionUr: out.description } });
    return { success: true, data: { productId, saved: save, ...out } };
  }

  /** Seller saves (their possibly edited) Urdu copy. No AI call, no credits. */
  async saveUrdu(sellerId: string, storeId: string, productId: string, body: { nameUr?: string; descriptionUr?: string }) {
    await this.verify(storeId, sellerId);
    const nameUr = cleanAiText(body.nameUr, 300);
    const descriptionUr = cleanAiText(body.descriptionUr, 6000);
    const res = await this.db.repositories.productModel.updateOne({ _id: productId, storeId, isDelete: false }, { $set: { nameUr, descriptionUr } });
    if (!res.matchedCount) throw new NotFoundException('Product not found in this store');
    return { success: true, data: { productId, nameUr, descriptionUr } };
  }

  /** Batch: translate up to `max` products that have no Urdu copy yet. Stops cleanly when credits run out or AI fails. */
  async translateBatch(sellerId: string, storeId: string, max = 10) {
    await this.verify(storeId, sellerId);
    const todo: any[] = await this.db.repositories.productModel
      .find({ storeId, isDelete: false, $or: [{ nameUr: null }, { nameUr: '' }, { nameUr: { $exists: false } }] })
      .select('_id name description').limit(Math.min(max, 25)).lean();
    const done: string[] = []; const failed: Array<{ productId: string; reason: string }> = [];
    let stoppedReason: string | null = null;
    for (const p of todo) {
      try {
        await this.translateProduct(sellerId, storeId, p._id.toString(), true);
        done.push(p._id.toString());
      } catch (e: any) {
        const code = e?.getResponse?.()?.errorCode;
        failed.push({ productId: p._id.toString(), reason: e?.message ?? 'failed' });
        if (code === 'INSUFFICIENT_AI_CREDITS' || code === 'AI_UNAVAILABLE' || code === 'AI_FEATURE_DISABLED' || code === 'AI_RATE_LIMITED') { stoppedReason = code; break; }
      }
    }
    return { success: true, data: { translated: done.length, remaining: Math.max(0, todo.length - done.length - failed.length), done, failed, stoppedReason } };
  }

  private async run(sellerId: string, storeId: string, title: string, description: string, direction: TranslateDirection) {
    const toUr = direction === 'en_to_ur';
    return this.ai.withCredits('translate_listing', storeId, sellerId, async () => {
      const r = await this.ai.generate({
        feature: 'translate_listing', tier: 'standard', storeId, sellerId, maxTokens: 2500, schema: TRANSLATE_SCHEMA,
        system: toUr
          ? 'Translate the marketplace listing from English into natural Urdu script. Keep meaning, line breaks, numbers, brand names and placeholders unchanged. Do not add claims. Put short notes in needsReview if the text contains Quran/hadith/ruling text that a scholar must verify.'
          : 'Translate the marketplace listing from Urdu into clear English. Keep meaning, line breaks, numbers, brand names and placeholders unchanged. Do not add claims. Put short notes in needsReview if the text contains Quran/hadith/ruling text that a scholar must verify.',
        messages: [{ role: 'user', content: `<title>${title}</title>\n<description>${description}</description>` }],
      });
      return {
        title: cleanAiText(r.json?.title, 300) ?? '',
        description: cleanAiText(r.json?.description, 6000) ?? '',
        needsReview: Array.isArray(r.json?.needsReview) ? r.json!.needsReview.map((x: any) => String(x).slice(0, 200)).slice(0, 5) : [],
      };
    });
  }
}
