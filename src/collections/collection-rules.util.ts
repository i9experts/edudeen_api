/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { CLASS_LEVELS, canonicalClass, classFilter, classIndex } from '../products/class-levels';

export const COLLECTION_SORTS = ['manual', 'newest', 'price_asc', 'price_desc', 'best_selling', 'rating'] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];
export const COLLECTION_LANGUAGES = ['ur', 'en', 'ar', 'mixed'] as const;

/** Hard cap on how many products a collection resolves to (same cap the automatic rule always had). */
export const COLLECTION_PRODUCT_CAP = 250;
const CANDIDATE_CAP = 2000;

export interface CollectionRules {
  categoryId: string | null;
  tags: string[];
  matchType: 'all' | 'any';
  priceMin: number | null;
  priceMax: number | null;
  createdWithinDays: number | null;
  minRating: number | null;
  hasDiscount: boolean;
  bestSellersTopN: number | null;
  language: string | null;
  classFrom: string | null;
  classTo: string | null;
}

const bad = (m: string) => new BadRequestException(m);

function num(v: unknown, name: string, min: number, max: number, integer = false): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  if (integer && !Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  return n;
}

/** Validates + normalises the rules of an automatic collection. Every bad value is a 400, nothing is silently dropped. */
export function cleanCollectionRules(raw: any): CollectionRules {
  const r = raw ?? {};
  const priceMin = num(r.priceMin, 'Minimum price', 0, 1_000_000_000);
  const priceMax = num(r.priceMax, 'Maximum price', 0, 1_000_000_000);
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) throw bad('Minimum price must not be greater than maximum price');

  const createdWithinDays = num(r.createdWithinDays, 'New within days', 1, 365, true);
  const minRating = num(r.minRating, 'Minimum rating', 1, 5);
  const bestSellersTopN = num(r.bestSellersTopN, 'Best sellers count', 1, 100, true);

  let language: string | null = null;
  if (r.language !== undefined && r.language !== null && r.language !== '') {
    if (!(COLLECTION_LANGUAGES as readonly string[]).includes(r.language)) throw bad(`language must be one of: ${COLLECTION_LANGUAGES.join(', ')}`);
    language = r.language;
  }

  let classFrom: string | null = null;
  let classTo: string | null = null;
  if (r.classFrom || r.classTo) {
    classFrom = r.classFrom ? canonicalClass(r.classFrom) : null;
    classTo = r.classTo ? canonicalClass(r.classTo) : null;
    if ((r.classFrom && !classFrom) || (r.classTo && !classTo)) throw bad('Class is not a known class level');
    // One end only = a single class.
    if (!classFrom) classFrom = classTo;
    if (!classTo) classTo = classFrom;
    if (classIndex(classFrom) > classIndex(classTo)) throw bad('"Class from" must not be after "Class to"');
  }

  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.filter((t: unknown) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean))].slice(0, 30) as string[] : [];
  if (r.matchType !== undefined && r.matchType !== null && r.matchType !== 'all' && r.matchType !== 'any') throw bad('matchType must be all or any');

  return {
    categoryId: typeof r.categoryId === 'string' && r.categoryId ? r.categoryId : null,
    tags,
    matchType: r.matchType === 'all' ? 'all' : 'any',
    priceMin, priceMax, createdWithinDays, minRating,
    hasDiscount: r.hasDiscount === true,
    bestSellersTopN, language, classFrom, classTo,
  };
}

export function cleanCollectionSort(v: unknown): CollectionSort {
  if (v === undefined || v === null || v === '') return 'manual';
  if (!(COLLECTION_SORTS as readonly string[]).includes(v as string)) throw bad(`sortBy must be one of: ${COLLECTION_SORTS.join(', ')}`);
  return v as CollectionSort;
}

/** Optional schedule. Returns Dates (or null). endAt must be after startAt. */
export function cleanCollectionWindow(startRaw: unknown, endRaw: unknown): { startAt: Date | null; endAt: Date | null } {
  const one = (v: unknown, name: string): Date | null => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v as any);
    if (Number.isNaN(d.getTime())) throw bad(`${name} is not a valid date`);
    return d;
  };
  const startAt = one(startRaw, 'Start date');
  const endAt = one(endRaw, 'End date');
  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) throw bad('End date must be after the start date');
  return { startAt, endAt };
}

export type WindowState = 'live' | 'scheduled' | 'ended';
export function collectionWindowState(c: { startAt?: Date | string | null; endAt?: Date | string | null }, now = new Date()): WindowState {
  if (c.startAt && new Date(c.startAt).getTime() > now.getTime()) return 'scheduled';
  if (c.endAt && new Date(c.endAt).getTime() <= now.getTime()) return 'ended';
  return 'live';
}

/** Mongo clause so public queries only see collections whose window is open (missing dates = always open). */
export function liveWindowClause(now = new Date()) {
  return {
    $and: [
      { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $gt: now } }] },
    ],
  };
}

interface Repos { productModel: any; productVariantModel: any }
export interface CollectionLike {
  type: 'manual' | 'automatic';
  productIds?: string[];
  rules?: Partial<CollectionRules> | null;
  sortBy?: string | null;
}

/**
 * THE one evaluator: which live products are in this collection, in the collection's own order.
 * Used by the store tab, the facet/count and the seller's live preview, so the three can never disagree.
 * Always excludes inactive / deleted / test products. Ids only (callers shape them).
 */
export async function evaluateCollectionIds(repos: Repos, storeId: string, col: CollectionLike, now = new Date()): Promise<string[]> {
  const { productModel, productVariantModel } = repos;
  const base: any = { storeId, isDelete: false, status: 'active', isTest: { $ne: true } };
  const sort = (COLLECTION_SORTS as readonly string[]).includes(col.sortBy ?? '') ? (col.sortBy as CollectionSort) : 'manual';
  const rules: Partial<CollectionRules> = col.type === 'automatic' ? (col.rules ?? {}) : {};

  if (col.type === 'manual') {
    const ids = col.productIds ?? [];
    if (ids.length === 0) return [];
    base._id = { $in: ids };
  } else {
    const clauses: any[] = [];
    if (rules.categoryId) clauses.push({ categoryId: rules.categoryId });
    if (rules.tags?.length) clauses.push({ tags: { $in: rules.tags } });
    if (clauses.length > 0) base[rules.matchType === 'all' ? '$and' : '$or'] = clauses;
    const and: any[] = [];
    if (rules.createdWithinDays) and.push({ createdAt: { $gte: new Date(now.getTime() - rules.createdWithinDays * 86_400_000) } });
    if (rules.minRating) and.push({ averageRating: { $gte: rules.minRating } });
    if (rules.language) and.push({ language: rules.language });
    if (rules.bestSellersTopN) and.push({ purchaseCount: { $gt: 0 } });
    if (rules.classFrom && rules.classTo) {
      const a = classIndex(rules.classFrom);
      const b = classIndex(rules.classTo);
      const ors = CLASS_LEVELS.filter((_, i) => i >= a && i <= b).map((c) => classFilter(c.value)).filter(Boolean);
      if (ors.length) and.push({ $or: ors });
    }
    if (and.length) base.$and = [...(base.$and ?? []), ...and];
  }

  const needsPrice = rules.priceMin != null || rules.priceMax != null || sort === 'price_asc' || sort === 'price_desc';
  const docs: any[] = await productModel
    .find(base).select('_id createdAt purchaseCount averageRating').sort({ createdAt: -1 }).limit(CANDIDATE_CAP).lean();
  let list = docs.map((d) => ({ id: String(d._id), createdAt: new Date(d.createdAt ?? 0).getTime(), sold: d.purchaseCount ?? 0, rating: d.averageRating ?? 0, price: 0 }));
  if (list.length === 0) return [];

  if (needsPrice || rules.hasDiscount) {
    const match: any = { productId: { $in: list.map((l) => l.id) }, status: 'active', isDelete: false };
    const rows: { _id: string; min: number; disc: number }[] = await productVariantModel.aggregate([
      { $match: match },
      { $group: { _id: '$productId', min: { $min: '$price' }, disc: { $max: { $cond: [{ $gt: ['$compareAtPrice', '$price'] }, 1, 0] } } } },
    ]);
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    list = list.filter((l) => {
      const r = byId.get(l.id);
      if (needsPrice) {
        if (!r) return false;
        if (rules.priceMin != null && r.min < rules.priceMin) return false;
        if (rules.priceMax != null && r.min > rules.priceMax) return false;
        l.price = r.min;
      }
      if (rules.hasDiscount && !(r && r.disc > 0)) return false;
      return true;
    });
  }

  if (rules.bestSellersTopN) {
    list = [...list].sort((a, b) => b.sold - a.sold || b.createdAt - a.createdAt).slice(0, rules.bestSellersTopN);
  }

  const tie = (a: any, b: any) => (a.id < b.id ? -1 : 1);
  if (sort === 'manual' && col.type === 'manual') {
    const pos = new Map((col.productIds ?? []).map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  } else if (sort === 'price_asc') list.sort((a, b) => a.price - b.price || tie(a, b));
  else if (sort === 'price_desc') list.sort((a, b) => b.price - a.price || tie(a, b));
  else if (sort === 'best_selling') list.sort((a, b) => b.sold - a.sold || b.createdAt - a.createdAt || tie(a, b));
  else if (sort === 'rating') list.sort((a, b) => b.rating - a.rating || b.createdAt - a.createdAt || tie(a, b));
  else list.sort((a, b) => b.createdAt - a.createdAt || tie(a, b)); // newest / automatic default

  return list.slice(0, COLLECTION_PRODUCT_CAP).map((l) => l.id);
}
