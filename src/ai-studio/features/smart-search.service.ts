/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../core/ai.service';
import { AiFlagsService } from '../core/ai-flags.service';
import { AiCatalogService, CURRICULA_KEYS, EDUCATION_LEVELS, PRODUCT_TYPES, SearchFilters, normalizeFilters } from './catalog.service';

export const SEARCH_REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    keywords: { type: 'array', items: { type: 'string' }, description: 'Search words in English AND Urdu script when useful, lowercase. Subject/topic words only.' },
    educationLevel: { type: 'string', enum: EDUCATION_LEVELS },
    productType: { type: 'string', enum: PRODUCT_TYPES },
    curricula: { type: 'array', items: { type: 'string', enum: CURRICULA_KEYS } },
    age: { type: 'integer' },
    minPrice: { type: 'number' },
    maxPrice: { type: 'number' },
    sort: { type: 'string', enum: ['newest', 'price_asc', 'price_desc', 'rating', 'popularity'] },
    language: { type: 'string', enum: ['en', 'ur', 'roman_ur'] },
  },
  required: ['keywords'],
  additionalProperties: false,
};

/** Pure, AI-free fallback: split the query into words (used when AI is off or fails). */
export function fallbackFilters(q: string): SearchFilters {
  const stop = new Set(['the', 'a', 'an', 'for', 'of', 'and', 'ki', 'ka', 'ke', 'ko', 'for', 'class', 'grade', 'with', 'in', 'to']);
  const words = q.toLowerCase().split(/[\s,;]+/).map((w) => w.trim()).filter((w) => w.length >= 2 && !stop.has(w));
  return normalizeFilters({ keywords: words });
}

/** Tiny TTL cache so the same query is only rewritten once. */
export class RewriteCache {
  private m = new Map<string, { at: number; v: SearchFilters }>();
  constructor(private max = 500, private ttlMs = 60 * 60 * 1000, private now = () => Date.now()) {}
  static key(q: string) { return q.toLowerCase().replace(/\s+/g, ' ').trim(); }
  get(q: string) {
    const e = this.m.get(RewriteCache.key(q));
    if (!e || this.now() - e.at > this.ttlMs) return null;
    return e.v;
  }
  set(q: string, v: SearchFilters) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(RewriteCache.key(q), { at: this.now(), v });
  }
}

@Injectable()
export class SmartSearchService {
  private readonly logger = new Logger(SmartSearchService.name);
  private readonly cache = new RewriteCache();

  constructor(private readonly ai: AiService, private readonly flags: AiFlagsService, private readonly catalog: AiCatalogService) {}

  /** Query (English / Urdu / Roman Urdu) -> structured filters -> existing catalogue search. Works without AI (keyword fallback). */
  async search(rawQuery: string, userId: string | null, limit = 12) {
    const q = String(rawQuery ?? '').trim().slice(0, 200);
    if (!q) return { success: true, data: { query: '', interpreted: null, usedAi: false, products: [] } };

    let filters: SearchFilters | null = this.cache.get(q);
    let usedAi = !!filters;
    if (!filters) {
      const aiOn = this.ai.isAvailable() && (await this.flags.isEnabled('smart_search'));
      if (aiOn) {
        try {
          const r = await this.ai.generate({
            feature: 'smart_search', tier: 'fast', maxTokens: 400, userId, schema: SEARCH_REWRITE_SCHEMA,
            system: 'Convert a shopper\'s search into structured filters for an education marketplace. The query may be English, Urdu or Roman Urdu. Only set a filter when the query clearly implies it (e.g. "class 5" -> educationLevel primary_school and age ~10; "islamiat"/"deen" -> islamic_education). Prices are given in the shopper\'s currency, copy numbers exactly. Never invent a restriction the shopper did not ask for.',
            messages: [{ role: 'user', content: `Search query: ${q}` }],
          });
          filters = normalizeFilters(r.json);
          if (!filters.keywords.length) filters.keywords = fallbackFilters(q).keywords;
          this.cache.set(q, filters);
          usedAi = true;
        } catch (e) {
          this.logger.debug(`rewrite failed, using fallback: ${(e as Error).message}`);
        }
      }
    }
    if (!filters) filters = fallbackFilters(q);

    let products = await this.catalog.search(filters);
    let relaxed = false;
    // Too strict (nothing found)? retry with keywords only so the buyer still sees something relevant.
    if (!products.length && (filters.educationLevel || filters.curricula || filters.age != null || filters.maxPrice || filters.minPrice || filters.productType)) {
      products = await this.catalog.search({ keywords: filters.keywords });
      relaxed = products.length > 0;
    }
    return { success: true, data: { query: q, interpreted: filters, usedAi, relaxed, products } };
  }
}
