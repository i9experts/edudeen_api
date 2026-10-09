import { ConfigService } from '@nestjs/config';
import { cleanVector, cosine, embeddingText, reciprocalRankFusion, textHash, topKByCosine } from './embedding.util';
import { EmbeddingError, EmbeddingService, VoyageEmbeddingProvider } from './embedding.service';

describe('embedding util', () => {
  it('cosine: identical = 1, orthogonal = 0, opposite = -1, never NaN', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
    expect(cosine(null, [1])).toBe(0);
  });

  it('topKByCosine ranks, applies minScore and breaks ties by id', () => {
    const items = [
      { id: 'b', vector: [1, 0] }, { id: 'a', vector: [1, 0] }, { id: 'c', vector: [0.7, 0.7] }, { id: 'd', vector: [0, 1] },
    ];
    expect(topKByCosine([1, 0], items, 3).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(topKByCosine([1, 0], items, 10, 0.5).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('reciprocal rank fusion: items in both lists win, order is deterministic, duplicates count once', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c'], ['c', 'd', 'a']]);
    expect(fused.map((x) => x.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(reciprocalRankFusion([['a', 'a', 'b']]).map((x) => x.id)).toEqual(['a', 'b']);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    // weights
    expect(reciprocalRankFusion([['a'], ['b']], { weights: [1, 3] })[0].id).toBe('b');
  });

  it('textHash is stable, and changes with the text or the model', () => {
    expect(textHash('hello', 'm1')).toBe(textHash('hello', 'm1'));
    expect(textHash('hello', 'm1')).not.toBe(textHash('hello!', 'm1'));
    expect(textHash('hello', 'm1')).not.toBe(textHash('hello', 'm2'));
    expect(textHash('x', 'm')).toHaveLength(32);
  });

  it('embeddingText joins the useful fields, strips html, is bounded and ignores empty products', () => {
    const t = embeddingText({ name: 'Grade 5 Math', description: '<p>Fractions &amp; decimals</p>', tags: ['math', 'fractions'], educationLevel: 'primary_school', productType: 'digital' });
    expect(t).toContain('Grade 5 Math');
    expect(t).toContain('Fractions');
    expect(t).not.toContain('<p>');
    expect(t).toContain('Level: primary school');
    expect(embeddingText({ name: 'x', description: 'y'.repeat(5000) }).length).toBeLessThanOrEqual(2000);
    expect(embeddingText({}).trim()).toBe('');
  });

  it('cleanVector rejects bad provider output', () => {
    expect(cleanVector([1, 2, 3])).toBeNull();
    expect(cleanVector(new Array(16).fill(0.5))).toHaveLength(16);
    expect(cleanVector([...new Array(15).fill(1), NaN])).toBeNull();
    expect(cleanVector('x')).toBeNull();
  });
});

const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;

describe('EmbeddingService', () => {
  it('is disabled without VOYAGE_API_KEY and never calls out', async () => {
    const s = new EmbeddingService(cfg({}));
    expect(s.isAvailable()).toBe(false);
    await expect(s.embedQuery('x')).rejects.toBeInstanceOf(EmbeddingError);
    await expect(s.embedDocuments(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('batches documents, pauses between batches, and caches queries', async () => {
    const s = new EmbeddingService(cfg({ VOYAGE_API_KEY: 'k', EMBEDDINGS_BATCH_SIZE: '2', EMBEDDINGS_MIN_INTERVAL_MS: '10' }));
    const sleeps: number[] = []; s.sleep = async (ms) => { sleeps.push(ms); };
    const embed = jest.fn(async (texts: string[]) => texts.map(() => new Array(8).fill(0.1)));
    s.setProviderForTesting({ name: 't', model: 'm', embed });
    const out = await s.embedDocuments(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(5);
    expect(embed).toHaveBeenCalledTimes(3);
    expect(sleeps.filter((x) => x === 10)).toHaveLength(2);
    embed.mockClear();
    await s.embedQuery('Fractions  Grade 5'); await s.embedQuery('fractions grade 5');
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 then gives up on a hard error', async () => {
    const s = new EmbeddingService(cfg({ VOYAGE_API_KEY: 'k' }));
    s.sleep = async () => undefined;
    const embed = jest.fn().mockRejectedValueOnce(new EmbeddingError('rate', true)).mockResolvedValue([new Array(8).fill(1)]);
    s.setProviderForTesting({ name: 't', model: 'm', embed });
    await expect(s.embedDocuments(['a'])).resolves.toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(2);
    const hard = jest.fn().mockRejectedValue(new EmbeddingError('bad key', false));
    s.setProviderForTesting({ name: 't', model: 'm', embed: hard });
    await expect(s.embedDocuments(['a'])).rejects.toThrow('bad key');
    expect(hard).toHaveBeenCalledTimes(1);
  });

  it('Voyage provider maps the response by index and rejects incomplete / failed responses', async () => {
    const ok = new VoyageEmbeddingProvider('k', 'voyage-3.5-lite', null, async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ index: 1, embedding: new Array(8).fill(2) }, { index: 0, embedding: new Array(8).fill(1) }] }) }));
    const v = await ok.embed(['a', 'b'], 'document');
    expect(v[0][0]).toBe(1); expect(v[1][0]).toBe(2);
    const bad = new VoyageEmbeddingProvider('k', 'm', null, async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ index: 0, embedding: [1] }] }) }));
    await expect(bad.embed(['a'], 'query')).rejects.toBeInstanceOf(EmbeddingError);
    let sent: any;
    const fail = new VoyageEmbeddingProvider('SECRET', 'm', 256, async (_u, init) => { sent = init; return { ok: false, status: 429, text: async () => '', json: async () => ({}) }; });
    const err: any = await fail.embed(['a'], 'query').catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('SECRET');
    expect(JSON.parse(sent.body).output_dimension).toBe(256);
  });
});
