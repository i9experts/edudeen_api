/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';

export const EDUCATION_LEVELS = ['preschool', 'primary_school', 'middle_school', 'secondary_school', 'college', 'university', 'professional_courses', 'islamic_education', 'other'];
export const PRODUCT_TYPES = ['physical', 'digital', 'educational'];
export const CURRICULA_KEYS = ['federal', 'punjab', 'sindh', 'kpk', 'balochistan', 'ajk_gb', 'cambridge_o', 'cambridge_a', 'igcse', 'ib', 'aku_eb', 'madrasa'];

export interface SearchFilters {
  keywords: string[];
  educationLevel?: string;
  productType?: string;
  curricula?: string[];
  age?: number;
  minPrice?: number;
  maxPrice?: number;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'rating' | 'popularity';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: sanitise filters coming from the model (or the user) into the strict shape we query with. */
export function normalizeFilters(raw: any): SearchFilters {
  const f: SearchFilters = { keywords: [] };
  const kws = Array.isArray(raw?.keywords) ? raw.keywords : typeof raw?.keywords === 'string' ? raw.keywords.split(/\s+/) : [];
  f.keywords = [...new Set(kws.map((k: any) => String(k).trim().toLowerCase().slice(0, 40)).filter((k: string) => k.length >= 2))].slice(0, 8) as string[];
  if (EDUCATION_LEVELS.includes(raw?.educationLevel)) f.educationLevel = raw.educationLevel;
  if (PRODUCT_TYPES.includes(raw?.productType)) f.productType = raw.productType;
  if (Array.isArray(raw?.curricula)) {
    const c = raw.curricula.filter((x: any) => CURRICULA_KEYS.includes(x));
    if (c.length) f.curricula = c;
  }
  const age = Number(raw?.age);
  if (Number.isFinite(age) && age >= 2 && age <= 25) f.age = Math.round(age);
  const min = Number(raw?.minPrice); const max = Number(raw?.maxPrice);
  if (Number.isFinite(min) && min > 0) f.minPrice = min;
  if (Number.isFinite(max) && max > 0 && (!f.minPrice || max >= f.minPrice)) f.maxPrice = max;
  if (['newest', 'price_asc', 'price_desc', 'rating', 'popularity'].includes(raw?.sort)) f.sort = raw.sort;
  return f;
}

/**
 * Pure: Mongo filter for the structured search. Keywords are matched (OR) against name, description and tags
 * (plus categories matched by name via `categoryIds`). No raw model text is ever put in the query unescaped.
 * Semantic (embedding) ranking is merged on top of this by SmartSearchService (see embeddings/semantic-index.service.ts).
 */
export function buildProductFilter(f: SearchFilters, activeStoreIds: string[], categoryIds: string[] = []): Record<string, any> {
  const q: Record<string, any> = { status: 'active', isDelete: false, storeId: { $in: activeStoreIds } };
  if (f.keywords.length) {
    const ors: any[] = [];
    for (const k of f.keywords) {
      const re = new RegExp(escapeRe(k), 'i');
      ors.push({ name: re }, { tags: re }, { description: re }, { nameUr: re });
    }
    if (categoryIds.length) ors.push({ categoryId: { $in: categoryIds } });
    q.$or = ors;
  }
  if (f.educationLevel) q.educationLevel = f.educationLevel;
  if (f.productType) q.productType = f.productType;
  if (f.curricula?.length) q.curricula = { $in: f.curricula };
  if (f.age != null) {
    q.$and = [
      { $or: [{ ageMin: null }, { ageMin: { $lte: f.age } }] },
      { $or: [{ ageMax: null }, { ageMax: { $gte: f.age } }] },
    ];
  }
  return q;
}

export interface ProductCard {
  id: string; slug: string; name: string; nameUr: string | null; image: string | null;
  price: number | null; currency: string | null; rating: number; ratingCount: number;
  productType: string; educationLevel: string | null; url: string;
}

/** Read-only catalogue access shared by smart search and the shopping assistant. */
@Injectable()
export class AiCatalogService {
  constructor(private readonly db: DatabaseService) {}
  private get r() { return this.db.repositories; }

  async search(f: SearchFilters, limit = 12): Promise<ProductCard[]> {
    const stores = await this.r.storeModel.find({ status: 'active', isDelete: false }, { _id: 1 }).lean();
    const activeIds = stores.map((s: any) => s._id.toString());
    let categoryIds: string[] = [];
    if (f.keywords.length) {
      const re = new RegExp(f.keywords.map(escapeRe).join('|'), 'i');
      const cats: any[] = await this.r.categoryModel.find({ name: re, isDelete: false }, { _id: 1 }).limit(10).lean();
      categoryIds = cats.map((c) => c._id.toString());
    }
    const filter = buildProductFilter(f, activeIds, categoryIds);
    const sortMap: Record<string, any> = {
      newest: { createdAt: -1 }, rating: { averageRating: -1, totalRatings: -1 },
      popularity: { purchaseCount: -1, viewCount: -1 }, price_asc: { createdAt: -1 }, price_desc: { createdAt: -1 },
    };
    const products: any[] = await this.r.productModel.find(filter).sort(sortMap[f.sort ?? 'popularity'] ?? { purchaseCount: -1 }).limit(60).lean();
    let cards = await this.toCards(products);
    if (f.minPrice != null) cards = cards.filter((c) => c.price != null && c.price >= f.minPrice!);
    if (f.maxPrice != null) cards = cards.filter((c) => c.price != null && c.price <= f.maxPrice!);
    if (f.sort === 'price_asc') cards.sort((a, b) => (a.price ?? 1e12) - (b.price ?? 1e12));
    if (f.sort === 'price_desc') cards.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
    return cards.slice(0, limit);
  }

  /** Ids of active, buyable products that satisfy the structured filters (keywords ignored): the bounded candidate set for semantic ranking. */
  async candidateIds(f: SearchFilters, limit = 1500): Promise<string[]> {
    const stores = await this.r.storeModel.find({ status: 'active', isDelete: false }, { _id: 1 }).lean();
    const filter = buildProductFilter({ ...f, keywords: [] }, stores.map((s: any) => s._id.toString()));
    const rows: any[] = await this.r.productModel.find(filter).select('_id').sort({ purchaseCount: -1, viewCount: -1 }).limit(limit).lean();
    return rows.map((p) => p._id.toString());
  }

  /** Cards for specific ids (re-checks active/store status), returned in the order of `ids`; price filters applied. */
  async cardsByIds(ids: string[], f: Pick<SearchFilters, 'minPrice' | 'maxPrice'> = {}): Promise<ProductCard[]> {
    const valid = ids.filter((i) => Types.ObjectId.isValid(i));
    if (!valid.length) return [];
    const stores = await this.r.storeModel.find({ status: 'active', isDelete: false }, { _id: 1 }).lean();
    const products: any[] = await this.r.productModel.find({ _id: { $in: valid }, status: 'active', isDelete: false, storeId: { $in: stores.map((s: any) => s._id.toString()) } }).lean();
    const byId = new Map(products.map((p) => [p._id.toString(), p]));
    let cards = await this.toCards(valid.map((i) => byId.get(i)).filter(Boolean));
    if (f.minPrice != null) cards = cards.filter((c) => c.price != null && c.price >= f.minPrice!);
    if (f.maxPrice != null) cards = cards.filter((c) => c.price != null && c.price <= f.maxPrice!);
    return cards;
  }

  async getOne(idOrSlug: string): Promise<(ProductCard & { description: string; tags: string[]; ageMin: number | null; ageMax: number | null; curricula: string[] }) | null> {
    const filter: any = { status: 'active', isDelete: false, ...(Types.ObjectId.isValid(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug }) };
    const p: any = await this.r.productModel.findOne(filter).lean();
    if (!p) return null;
    const [card] = await this.toCards([p]);
    return { ...card, description: String(p.description ?? '').slice(0, 1200), tags: p.tags ?? [], ageMin: p.ageMin ?? null, ageMax: p.ageMax ?? null, curricula: p.curricula ?? [] };
  }

  private async toCards(products: any[]): Promise<ProductCard[]> {
    if (!products.length) return [];
    const ids = products.map((p) => p._id.toString());
    const variants: any[] = await this.r.productVariantModel.find({ productId: { $in: ids }, isDelete: { $ne: true } }).select('productId price currency').lean();
    const min = new Map<string, { price: number; currency: string | null }>();
    for (const v of variants) {
      const cur = min.get(v.productId);
      if (!cur || v.price < cur.price) min.set(v.productId, { price: v.price, currency: v.currency ?? null });
    }
    return products.map((p) => {
      const id = p._id.toString();
      const m = min.get(id);
      return {
        id, slug: p.slug, name: p.name, nameUr: p.nameUr ?? null, image: p.images?.[0] ?? null,
        price: m?.price ?? null, currency: m?.currency ?? null,
        rating: Math.round((p.averageRating ?? 0) * 10) / 10, ratingCount: p.totalRatings ?? 0,
        productType: p.productType, educationLevel: p.educationLevel ?? null, url: `/product/${p.slug}`,
      };
    });
  }
}
