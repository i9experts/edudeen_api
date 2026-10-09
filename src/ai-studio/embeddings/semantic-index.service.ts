/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { AiFlagsService } from '../core/ai-flags.service';
import { AiCatalogService, SearchFilters } from '../features/catalog.service';
import { EmbeddingService } from './embedding.service';
import { embeddingText, textHash, topKByCosine } from './embedding.util';
import { ProductEmbedding, ProductEmbeddingDocument } from './product-embedding.schema';

export interface SyncResult { available: boolean; scanned: number; embedded: number; unchanged: number; skippedEmpty: number; remaining: number; failed: boolean }

/**
 * Keeps one embedding per active product and answers "which products are closest to this query?".
 *  - sync: idempotent, batched, rate limited; only products whose text/model hash changed are re-embedded.
 *  - rank: in-process cosine over a bounded candidate set (default), or MongoDB Atlas $vectorSearch when ATLAS_VECTOR_INDEX is set.
 * Everything is a no-op / empty when embeddings are not configured (no VOYAGE_API_KEY).
 */
@Injectable()
export class SemanticIndexService {
  private readonly logger = new Logger(SemanticIndexService.name);
  private readonly atlasIndex: string | null;
  private readonly maxCandidates: number;
  private readonly minScore: number;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly embeddings: EmbeddingService,
    private readonly db: DatabaseService,
    private readonly flags: AiFlagsService,
    private readonly catalog: AiCatalogService,
    @InjectModel(ProductEmbedding.name) private readonly model: Model<ProductEmbeddingDocument>,
  ) {
    this.atlasIndex = config.get<string>('ATLAS_VECTOR_INDEX') || null;
    const mc = Number(config.get<string>('SEMANTIC_MAX_CANDIDATES')); const ms = Number(config.get<string>('SEMANTIC_MIN_SCORE'));
    this.maxCandidates = Number.isFinite(mc) && mc > 0 ? Math.min(5000, Math.floor(mc)) : 1500;
    this.minScore = Number.isFinite(ms) ? ms : 0.3;
  }

  get usesAtlas(): boolean { return !!this.atlasIndex; }
  isAvailable(): boolean { return this.embeddings.isAvailable(); }

  async status() {
    const [products, indexed] = await Promise.all([
      this.db.repositories.productModel.countDocuments({ status: 'active', isDelete: false }),
      this.model.countDocuments({}),
    ]);
    return { available: this.isAvailable(), provider: this.embeddings.providerName, model: this.embeddings.model, activeProducts: products, indexed, atlasVectorSearch: this.usesAtlas };
  }

  /**
   * Embeds products that are new or changed. `sinceMs` limits the scan to recently updated products (incremental run);
   * omit for a full backfill. At most `maxEmbed` vectors are produced per call so a run stays bounded; `remaining` says how many are left.
   */
  async sync(opts: { sinceMs?: number; maxEmbed?: number } = {}): Promise<SyncResult> {
    const base: SyncResult = { available: this.isAvailable(), scanned: 0, embedded: 0, unchanged: 0, skippedEmpty: 0, remaining: 0, failed: false };
    if (!this.isAvailable() || this.running) return base;
    this.running = true;
    try {
      const model = this.embeddings.model as string;
      const maxEmbed = Math.max(1, Math.min(2000, opts.maxEmbed ?? 200));
      const pm = this.db.repositories.productModel;
      const filter: Record<string, any> = { status: 'active', isDelete: false };
      if (opts.sinceMs) filter.updatedAt = { $gte: new Date(Date.now() - opts.sinceMs) };
      let lastId: string | null = null;
      for (;;) {
        const page: any[] = await pm.find(lastId ? { ...filter, _id: { $gt: lastId } } : filter)
          .select('name nameUr description descriptionUr tags educationLevel productType curricula ageMin ageMax storeId')
          .sort({ _id: 1 }).limit(100).lean();
        if (!page.length) break;
        lastId = page[page.length - 1]._id.toString();
        base.scanned += page.length;
        const existing: any[] = await this.model.find({ productId: { $in: page.map((p) => p._id.toString()) } }).select('productId textHash').lean();
        const known = new Map(existing.map((e) => [e.productId, e.textHash]));
        const todo: Array<{ id: string; storeId: string | null; text: string; hash: string }> = [];
        for (const p of page) {
          const id = p._id.toString();
          const text = embeddingText(p);
          if (!text.trim()) { base.skippedEmpty++; continue; }
          const hash = textHash(text, model);
          if (known.get(id) === hash) { base.unchanged++; continue; }
          todo.push({ id, storeId: p.storeId ?? null, text, hash });
        }
        const room = maxEmbed - base.embedded;
        const now = todo.slice(0, Math.max(0, room));
        base.remaining += todo.length - now.length;
        if (now.length) {
          try {
            const vectors = await this.embeddings.embedDocuments(now.map((t) => t.text));
            await this.model.bulkWrite(now.map((t, i) => ({
              updateOne: { filter: { productId: t.id }, update: { $set: { productId: t.id, storeId: t.storeId, embeddingModel: model, textHash: t.hash, vector: vectors[i] } }, upsert: true },
            })));
            base.embedded += now.length;
          } catch (e) {
            this.logger.warn(`embedding batch failed: ${(e as Error).message}`);
            base.failed = true;
            base.remaining += now.length;
            break;
          }
        }
      }
      return base;
    } finally {
      this.running = false;
    }
  }

  /** Drop vectors of products that are gone or no longer active (keeps the collection tidy). */
  async prune(): Promise<number> {
    const ids: string[] = (await this.model.find({}).select('productId').lean()).map((e: any) => e.productId);
    if (!ids.length) return 0;
    const live = new Set((await this.db.repositories.productModel.find({ _id: { $in: ids }, status: 'active', isDelete: false }).select('_id').lean()).map((p: any) => p._id.toString()));
    const dead = ids.filter((i) => !live.has(i));
    if (dead.length) await this.model.deleteMany({ productId: { $in: dead } });
    return dead.length;
  }

  /**
   * Product ids closest to the query, best first. Returns [] (never throws) when embeddings are off, the admin switched the
   * feature off, nothing is indexed, or the provider fails: callers then simply use the keyword result.
   */
  async rank(query: string, filters: SearchFilters, limit = 24): Promise<string[]> {
    if (!this.isAvailable()) return [];
    try {
      if (!(await this.flags.isEnabled('semantic_search'))) return [];
      const q = await this.embeddings.embedQuery(query);
      if (this.atlasIndex) {
        const viaAtlas = await this.rankAtlas(q, limit).catch((e) => { this.logger.warn(`Atlas vector search failed, using in-process: ${(e as Error).message}`); return null; });
        if (viaAtlas) return viaAtlas;
      }
      const candidates = await this.catalog.candidateIds(filters, this.maxCandidates);
      if (!candidates.length) return [];
      const rows: any[] = await this.model.find({ productId: { $in: candidates }, embeddingModel: this.embeddings.model as string }).select('productId vector').lean();
      return topKByCosine(q, rows.map((r) => ({ id: r.productId as string, vector: r.vector as number[] })), limit, this.minScore).map((x) => x.id);
    } catch (e) {
      this.logger.debug(`semantic rank skipped: ${(e as Error).message}`);
      return [];
    }
  }

  /** MongoDB Atlas $vectorSearch (index created by the owner: path "vector", cosine, dims = model dims). */
  private async rankAtlas(queryVector: number[], limit: number): Promise<string[]> {
    const rows: any[] = await this.model.aggregate([
      { $vectorSearch: { index: this.atlasIndex as string, path: 'vector', queryVector, numCandidates: Math.max(100, limit * 10), limit } },
      { $project: { _id: 0, productId: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);
    return rows.filter((r) => (r.score ?? 0) >= this.minScore).map((r) => r.productId as string);
  }
}
