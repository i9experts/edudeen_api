/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ProductsService } from '../products/products.service';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import { EducationLevel } from '../products/schemas/product.schema';
import { SavedListsService } from './saved-lists.service';
import { LearningPath, LearningPathDocument } from './schemas/learning-path.schema';

export const MAX_PATH_STEPS = 12;
export const MAX_STEP_PICKS = 12;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const LEVELS = Object.values(EducationLevel) as string[];

/** Validates the admin form; `partial` for PATCH. Pure, so it is unit-tested. */
export function cleanLearningPathInput(body: any, partial = false) {
  const out: any = {};
  if (!partial || body?.title !== undefined) {
    out.title = str(body?.title, 100);
    if (!out.title) throw new BadRequestException('Give the path a title');
  }
  if (body?.slug !== undefined || !partial) {
    const slug = slugify(str(body?.slug, 80) || out.title || '');
    if (!slug) throw new BadRequestException('Give the path a web address');
    out.slug = slug;
  }
  if (body?.educationLevel !== undefined) {
    const lvl = str(body.educationLevel, 40);
    if (lvl && !LEVELS.includes(lvl)) throw new BadRequestException('Unknown grade / level');
    out.educationLevel = lvl || null;
  }
  if (body?.ageLabel !== undefined) out.ageLabel = str(body.ageLabel, 40);
  if (body?.subtitle !== undefined) out.subtitle = str(body.subtitle, 160);
  if (body?.description !== undefined) out.description = str(body.description, 2000);
  if (body?.image !== undefined) out.image = str(body.image, 1000) || null;
  if (body?.status !== undefined) out.status = body.status === 'active' ? 'active' : 'draft';
  if (body?.order !== undefined) out.order = Math.max(0, Math.min(999, Math.round(Number(body.order) || 0)));
  if (body?.steps !== undefined) {
    if (!Array.isArray(body.steps)) throw new BadRequestException('Steps must be a list');
    if (body.steps.length > MAX_PATH_STEPS) throw new BadRequestException(`A path can have up to ${MAX_PATH_STEPS} steps`);
    out.steps = body.steps.map((s: any) => {
      const title = str(s?.title, 80);
      if (!title) throw new BadRequestException('Every step needs a title (e.g. Maths)');
      const ids = Array.isArray(s?.productIds) ? [...new Set(s.productIds.filter((x: unknown) => typeof x === 'string' && isValidObjectId(x)))] as string[] : [];
      if (ids.length > MAX_STEP_PICKS) throw new BadRequestException(`A step can have up to ${MAX_STEP_PICKS} picks`);
      return { title, note: str(s?.note, 200), productIds: ids };
    });
  }
  if (out.status === 'active' && body?.steps !== undefined && !out.steps.some((s: any) => s.productIds.length)) {
    throw new BadRequestException('Add at least one product before making a path live');
  }
  return out;
}

@Injectable()
export class LearningPathsService {
  constructor(
    @InjectModel(LearningPath.name) private readonly model: Model<LearningPathDocument>,
    private readonly productsService: ProductsService,
    private readonly databaseService: DatabaseService,
    private readonly savedLists: SavedListsService,
  ) {}

  private shape(p: any) {
    return {
      _id: p._id, title: p.title, slug: p.slug, educationLevel: p.educationLevel, ageLabel: p.ageLabel,
      subtitle: p.subtitle, description: p.description, image: p.image, stepCount: p.steps?.length ?? 0,
    };
  }

  async list(level?: string) {
    const filter: any = { status: 'active' };
    if (level) filter.educationLevel = String(level).slice(0, 40);
    const rows = await this.model.find(filter).sort({ order: 1, createdAt: -1 }).limit(60).lean();
    return { success: true, data: rows.map((p) => this.shape(p)) };
  }

  /** Resolves each step's picks through the same live-product gate every public list uses (inactive items drop out). */
  private async resolve(p: any, viewerId?: string | null) {
    const ids = [...new Set((p.steps as any[]).flatMap((s) => s.productIds))];
    const shaped = (await this.productsService.getShapedProductsByIds(ids, viewerId ?? null)).map((x: any) => sanitizeDigitalForPublicView(x));
    const byId = new Map(shaped.map((x: any) => [String(x._id), x]));
    return (p.steps as any[]).map((s) => ({
      _id: s._id, title: s.title, note: s.note,
      products: s.productIds.map((id: string) => byId.get(id)).filter(Boolean),
    }));
  }

  async bySlug(slug: string, viewerId?: string | null) {
    const p = await this.model.findOne({ status: 'active', slug: String(slug ?? '') }).lean();
    if (!p) throw new NotFoundException('This learning path is not available');
    return { success: true, data: { ...this.shape(p), steps: await this.resolve(p, viewerId) } };
  }

  /** Copies the path's live products into a new private reading list owned by the parent. */
  async saveToList(userId: string, slug: string) {
    const p = await this.model.findOne({ status: 'active', slug: String(slug ?? '') }).lean();
    if (!p) throw new NotFoundException('This learning path is not available');
    const steps = await this.resolve(p, userId);
    const ids = [...new Set(steps.flatMap((s) => s.products.map((x: any) => String(x._id))))];
    if (!ids.length) throw new BadRequestException('There is nothing to save in this path yet');
    const created: any = await this.savedLists.create(userId, { name: `Reading list: ${p.title}`.slice(0, 80), description: p.subtitle || '', isPublic: false });
    const listId = String(created.data._id);
    let added = 0;
    for (const id of ids) {
      const r: any = await this.savedLists.addItem(userId, listId, { productId: id }).catch(() => null);
      if (r?.data?.added) added++;
    }
    return { success: true, message: 'Saved as your reading list', data: { listId, slug: created.data.slug, added } };
  }

  // ── Admin ─────────────────────────────────────────────────────────────────
  async adminList() {
    return { success: true, data: await this.model.find().sort({ order: 1, createdAt: -1 }).lean() };
  }

  async adminGet(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Path not found');
    const p = await this.model.findById(id).lean();
    if (!p) throw new NotFoundException('Path not found');
    // names for the editor (the path itself stores only ids)
    const ids = [...new Set((p.steps as any[]).flatMap((s) => s.productIds))].filter((x) => isValidObjectId(x));
    const rows: any[] = ids.length ? await this.databaseService.repositories.productModel.find({ _id: { $in: ids } }).select('_id name').lean() : [];
    const productNames: Record<string, string> = {};
    for (const r of rows) productNames[String(r._id)] = r.name;
    return { success: true, data: { ...p, productNames } };
  }

  async adminCreate(body: any) {
    const input = cleanLearningPathInput(body);
    if (await this.model.exists({ slug: input.slug })) throw new BadRequestException('Another path already uses that web address');
    return { success: true, message: 'Path created', data: await this.model.create(input) };
  }

  async adminUpdate(id: string, body: any) {
    if (!isValidObjectId(id)) throw new NotFoundException('Path not found');
    const input = cleanLearningPathInput(body, true);
    if (input.status === 'active' && body?.steps === undefined) {
      const cur = await this.model.findById(id).select('steps').lean();
      if (!cur?.steps?.some((s: any) => s.productIds?.length)) throw new BadRequestException('Add at least one product before making a path live');
    }
    if (input.slug && await this.model.exists({ slug: input.slug, _id: { $ne: id } })) throw new BadRequestException('Another path already uses that web address');
    const p = await this.model.findByIdAndUpdate(id, { $set: input }, { returnDocument: 'after' });
    if (!p) throw new NotFoundException('Path not found');
    return { success: true, message: 'Path saved', data: p };
  }

  async adminDelete(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Path not found');
    const p = await this.model.findByIdAndDelete(id);
    if (!p) throw new NotFoundException('Path not found');
    return { success: true, message: 'Path deleted' };
  }
}
