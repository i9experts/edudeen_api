/* eslint-disable prettier/prettier */
import { createHash } from 'crypto';

/** Pure helpers for semantic search (no I/O, unit tested). */

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

export interface EmbeddableProduct {
  name?: string | null; nameUr?: string | null; description?: string | null; descriptionUr?: string | null;
  tags?: string[] | null; educationLevel?: string | null; productType?: string | null; curricula?: string[] | null;
  ageMin?: number | null; ageMax?: number | null;
}

/** The text that represents a product for embedding. Same product fields -> same text -> same hash. */
export function embeddingText(p: EmbeddableProduct, maxChars = 2000): string {
  const parts = [
    p.name, p.nameUr,
    p.educationLevel ? `Level: ${String(p.educationLevel).replace(/_/g, ' ')}` : null,
    p.productType ? `Type: ${p.productType}` : null,
    p.curricula?.length ? `Curriculum: ${p.curricula.join(', ')}` : null,
    p.ageMin != null || p.ageMax != null ? `Ages ${p.ageMin ?? ''}-${p.ageMax ?? ''}` : null,
    p.tags?.length ? `Tags: ${p.tags.join(', ')}` : null,
    p.description ? stripHtml(String(p.description)) : null,
    p.descriptionUr ? stripHtml(String(p.descriptionUr)) : null,
  ].filter((x): x is string => !!x && String(x).trim().length > 0);
  return parts.join('\n').slice(0, maxChars);
}

/** Stable hash of the text and the model: a changed text OR a changed model re-embeds, nothing else does. */
export function textHash(text: string, model: string): string {
  return createHash('sha256').update(`${model}\n${text}`).digest('hex').slice(0, 32);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: ArrayLike<number>): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]; 0 for empty / zero / mismatched-length vectors (never NaN). */
export function cosine(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  const na = norm(a); const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

/** Top-k by cosine against a query vector, ties broken by id for determinism. Items below `minScore` are dropped. */
export function topKByCosine<T extends { id: string; vector: ArrayLike<number> }>(query: ArrayLike<number>, items: T[], k: number, minScore = 0): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const it of items) {
    const score = cosine(query, it.vector);
    if (score >= minScore) scored.push({ id: it.id, score });
  }
  scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
  return scored.slice(0, Math.max(0, k));
}

/**
 * Reciprocal-rank fusion: each ranked list contributes 1 / (k + rank). Robust when the lists have different scales
 * (keyword order vs cosine). `weights` lets one list count more. Returns ids best-first.
 */
export function reciprocalRankFusion(lists: string[][], opts: { k?: number; weights?: number[] } = {}): Array<{ id: string; score: number }> {
  const k = opts.k ?? 60;
  const scores = new Map<string, number>();
  lists.forEach((list, li) => {
    const w = opts.weights?.[li] ?? 1;
    const seen = new Set<string>();
    list.forEach((id, rank) => {
      if (seen.has(id)) return; // a duplicate inside one list counts once (its best rank)
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + w / (k + rank + 1));
    });
  });
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

/** Validates a vector coming back from a provider (finite numbers only, sane size). */
export function cleanVector(v: unknown, maxDims = 4096): number[] | null {
  if (!Array.isArray(v) || v.length < 8 || v.length > maxDims) return null;
  const out: number[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const n = Number(v[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}
