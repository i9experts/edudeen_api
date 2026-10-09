/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cleanVector } from './embedding.util';

export type EmbedInputType = 'document' | 'query';

/** Provider adapter: plug another vendor by implementing this and returning it from EmbeddingService's constructor. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(texts: string[], inputType: EmbedInputType): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** Voyage AI (https://docs.voyageai.com/reference/embeddings-api). Key from env only. */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly outputDim: number | null = null,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as any,
    private readonly baseUrl = 'https://api.voyageai.com/v1/embeddings',
  ) {}

  async embed(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
    if (!texts.length) return [];
    const body: Record<string, unknown> = { input: texts, model: this.model, input_type: inputType, truncation: true };
    if (this.outputDim) body.output_dimension = this.outputDim;
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new EmbeddingError(`Embedding provider error (${res.status})`, res.status === 429 || res.status >= 500);
    }
    const json = await res.json();
    const rows: Array<{ index: number; embedding: unknown }> = Array.isArray(json?.data) ? json.data : [];
    const out: number[][] = new Array(texts.length);
    for (const r of rows) {
      const v = cleanVector(r.embedding);
      if (v && Number.isInteger(r.index) && r.index >= 0 && r.index < texts.length) out[r.index] = v;
    }
    if (Array.from(out).some((v) => !v)) throw new EmbeddingError('Embedding provider returned an incomplete result', true);
    return out;
  }
}

/**
 * Semantic-search embeddings gateway. DISABLED (isAvailable() === false, no network call ever) unless VOYAGE_API_KEY is set.
 * Env: VOYAGE_API_KEY, VOYAGE_BASE_URL (tests/proxy only), VOYAGE_MODEL (default voyage-3.5-lite), VOYAGE_OUTPUT_DIM (optional), EMBEDDINGS_BATCH_SIZE (default 32),
 * EMBEDDINGS_MIN_INTERVAL_MS (pause between batches, default 400).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private provider: EmbeddingProvider | null;
  readonly batchSize: number;
  readonly minIntervalMs: number;
  private readonly queryCache = new Map<string, number[]>();
  /** Test hook: replace the sleep used between batches / retries. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(config: ConfigService) {
    const key = config.get<string>('VOYAGE_API_KEY');
    const dim = Number(config.get<string>('VOYAGE_OUTPUT_DIM'));
    this.provider = key ? new VoyageEmbeddingProvider(key, config.get<string>('VOYAGE_MODEL') || 'voyage-3.5-lite', Number.isFinite(dim) && dim > 0 ? dim : null, undefined, config.get<string>('VOYAGE_BASE_URL') || undefined) : null;
    const bs = Number(config.get<string>('EMBEDDINGS_BATCH_SIZE')); const mi = Number(config.get<string>('EMBEDDINGS_MIN_INTERVAL_MS'));
    this.batchSize = Number.isFinite(bs) && bs > 0 ? Math.min(128, Math.floor(bs)) : 32;
    this.minIntervalMs = Number.isFinite(mi) && mi >= 0 ? mi : 400;
  }

  isAvailable(): boolean { return !!this.provider; }
  get model(): string | null { return this.provider?.model ?? null; }
  get providerName(): string | null { return this.provider?.name ?? null; }

  /** Test hook. */
  setProviderForTesting(p: EmbeddingProvider | null) { this.provider = p; this.queryCache.clear(); }

  /** Embeds in provider-sized batches with a pause between them and retry/backoff on 429/5xx. Throws EmbeddingError. */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!this.provider) throw new EmbeddingError('Embeddings are not configured');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      if (i > 0 && this.minIntervalMs > 0) await this.sleep(this.minIntervalMs);
      out.push(...(await this.withRetry(() => this.provider!.embed(texts.slice(i, i + this.batchSize), 'document'))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!this.provider) throw new EmbeddingError('Embeddings are not configured');
    const key = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
    const hit = this.queryCache.get(key);
    if (hit) return hit;
    const [v] = await this.withRetry(() => this.provider!.embed([key], 'query'), 1);
    if (this.queryCache.size >= 300) this.queryCache.delete(this.queryCache.keys().next().value as string);
    this.queryCache.set(key, v);
    return v;
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (e) {
        const retryable = e instanceof EmbeddingError ? e.retryable : true;
        if (!retryable || attempt >= maxRetries) throw e;
        await this.sleep(Math.min(8000, 600 * 2 ** attempt));
      }
    }
  }
}
