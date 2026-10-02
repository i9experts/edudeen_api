/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ProductsService } from '../products/products.service';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import { CURRICULA } from '../products/schemas/product.schema';
import { CuratedCollection, CuratedCollectionDocument } from './schemas/curated-collection.schema';

export const MAX_PICKED = 60;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Validates the admin form; `partial` for PATCH. */
export function cleanCollectionInput(body: any, partial = false) {
  const out: any = {};
  if (!partial || body?.title !== undefined) {
    out.title = str(body?.title, 100);
    if (!out.title) throw new BadRequestException('Give the collection a title');
  }
  if (body?.slug !== undefined || !partial) {
    const slug = slugify(str(body?.slug, 80) || out.title || '');
    if (!slug) throw new BadRequestException('Give the collection a web address');
    out.slug = slug;
  }
  if (body?.subtitle !== undefined) out.subtitle = str(body.subtitle, 160);
  if (body?.description !== undefined) out.description = str(body.description, 2000);
  if (body?.image !== undefined) out.image = str(body.image, 1000) || null;
  if (body?.productIds !== undefined) {
    const ids = Array.isArray(body.productIds) ? [...new Set(body.productIds.filter((x: unknown) => typeof x === 'string' && isValidObjectId(x)))] as string[] : [];
    if (ids.length > MAX_PICKED) throw new BadRequestException(`Pick up to ${MAX_PICKED} products`);
    out.productIds = ids;
  }
  if (body?.rule !== undefined) {
    const r = body.rule ?? {};
    const curriculum = str(r.curriculum, 40) || null;
    if (curriculum && !(CURRICULA as readonly string[]).includes(curriculum)) throw new BadRequestException('Unknown exam board');
    out.rule = {
      educationLevel: str(r.educationLevel, 60) || null,
      curriculum,
      categoryId: isValidObjectId(r.categoryId) ? String(r.categoryId) : null,
      tags: Array.isArray(r.tags) ? r.tags.map((t: unknown) => str(t, 40).toLowerCase()).filter(Boolean).slice(0, 10) : [],
    };
  }
  if (body?.status !== undefined) out.status = body.status === 'active' ? 'active' : 'draft';
  if (typeof body?.showOnHome === 'boolean') out.showOnHome = body.showOnHome;
  if (body?.order !== undefined) out.order = Math.max(0, Math.min(999, Math.round(Number(body.order) || 0)));
  for (const k of ['startsAt', 'endsAt'] as const) {
    if (body?.[k] !== undefined) {
      const d = body[k] ? new Date(body[k]) : null;
      if (d && Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
      out[k] = d;
    }
  }
  if (out.startsAt && out.endsAt && out.endsAt <= out.startsAt) throw new BadRequestException('The end date must be after the start date');
  return out;
}

const hasRule = (r: any) => !!(r && (r.educationLevel || r.curriculum || r.categoryId || r.tags?.length));

@Injectable()
export class CuratedCollectionsService {
  constructor(
    @InjectModel(CuratedCollection.name) private readonly model: Model<CuratedCollectionDocument>,
    private readonly databaseService: DatabaseService,
    private readonly productsService: ProductsService,
  ) {}

  private liveFilter() {
    const now = new Date();
    return {
      status: 'active',
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      ],
    };
  }

  /** Hand-picked products first (in the admin's order), then rule matches by sales. */
  private async resolveProducts(c: any, limit: number, viewerId?: string | null) {
    const picked = c.productIds?.length ? await this.productsService.getShapedProductsByIds(c.productIds.slice(0, limit), viewerId ?? null) : [];
    let products: any[] = picked;
    if (products.length < limit && hasRule(c.rule)) {
      const filter: any = { status: 'active', isDelete: false, _id: { $nin: products.map((p: any) => p._id) } };
      if (c.rule.educationLevel) filter.educationLevel = c.rule.educationLevel;
      if (c.rule.curriculum) filter.curricula = c.rule.curriculum;
      if (c.rule.categoryId) filter.$or = [{ categoryId: c.rule.categoryId }, { subCategoryId: c.rule.categoryId }];
      if (c.rule.tags?.length) filter.tags = { $in: c.rule.tags };
      const ids = (await this.databaseService.repositories.productModel.find(filter).sort({ purchaseCount: -1, averageRating: -1 }).limit(limit - products.length).select('_id').lean()).map((p: any) => String(p._id));
      products = [...products, ...(await this.productsService.getShapedProductsByIds(ids, viewerId ?? null))];
    }
    return products.map((p: any) => sanitizeDigitalForPublicView(p));
  }

  private shape(c: any) {
    return { _id: c._id, title: c.title, slug: c.slug, subtitle: c.subtitle, description: c.description, image: c.image };
  }

  async homeShelves(viewerId?: string | null) {
    const rows = await this.model.find({ ...this.liveFilter(), showOnHome: true }).sort({ order: 1, createdAt: -1 }).limit(6).lean();
    const shelves = await Promise.all(rows.map(async c => ({ ...this.shape(c), products: await this.resolveProducts(c, 12, viewerId) })));
    return { success: true, data: shelves.filter(s => s.products.length > 0) };
  }

  async bySlug(slug: string, viewerId?: string | null) {
    const c = await this.model.findOne({ ...this.liveFilter(), slug: String(slug ?? '') }).lean();
    if (!c) throw new NotFoundException('This collection is not available');
    return { success: true, data: { ...this.shape(c), products: await this.resolveProducts(c, MAX_PICKED, viewerId) } };
  }

  // ── Admin ─────────────────────────────────────────────────────────────────
  async adminList() {
    const rows = await this.model.find().sort({ order: 1, createdAt: -1 }).lean();
    return { success: true, data: rows };
  }

  async adminGet(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Collection not found');
    const c = await this.model.findById(id).lean();
    if (!c) throw new NotFoundException('Collection not found');
    const products = c.productIds.length
      ? await this.databaseService.repositories.productModel.find({ _id: { $in: c.productIds } }).select('_id name slug images status').lean()
      : [];
    const byId = new Map(products.map((p: any) => [String(p._id), p]));
    return { success: true, data: { ...c, products: c.productIds.map(id => byId.get(id)).filter(Boolean) } };
  }

  async adminCreate(body: any) {
    const input = cleanCollectionInput(body);
    if (await this.model.exists({ slug: input.slug })) throw new BadRequestException('Another collection already uses that web address');
    const c = await this.model.create(input);
    return { success: true, message: 'Collection created', data: c };
  }

  async adminUpdate(id: string, body: any) {
    if (!isValidObjectId(id)) throw new NotFoundException('Collection not found');
    const input = cleanCollectionInput(body, true);
    if (input.slug && await this.model.exists({ slug: input.slug, _id: { $ne: id } })) throw new BadRequestException('Another collection already uses that web address');
    const c = await this.model.findByIdAndUpdate(id, { $set: input }, { returnDocument: 'after' });
    if (!c) throw new NotFoundException('Collection not found');
    return { success: true, message: 'Collection saved', data: c };
  }

  async adminDelete(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Collection not found');
    const c = await this.model.findByIdAndDelete(id);
    if (!c) throw new NotFoundException('Collection not found');
    return { success: true, message: 'Collection deleted' };
  }

  /** Product search for the admin picker — name match across all live listings. */
  async adminSearchProducts(q: string) {
    const term = str(q, 60);
    if (term.length < 2) return { success: true, data: [] };
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const rows = await this.databaseService.repositories.productModel.find({ status: 'active', isDelete: false, name: rx }).select('_id name slug images storeId').limit(20).lean();
    return { success: true, data: rows.map((p: any) => ({ _id: String(p._id), name: p.name, slug: p.slug, image: p.images?.[0] ?? null })) };
  }
}
