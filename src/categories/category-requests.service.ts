/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { getAncestorChain } from './category-tree.util';
import { CATEGORY_REQUEST_TYPES, CategoryRequest, CategoryRequestDocument } from './category-request.schema';

export const MAX_PENDING_REQUESTS_PER_STORE = 3;

export interface RequestInput { type?: unknown; name?: unknown; reason?: unknown; exampleProduct?: unknown }

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** Pure validation of the seller's form. */
export function cleanRequestInput(body: RequestInput) {
  const type = String(body?.type ?? 'subcategory');
  if (!(CATEGORY_REQUEST_TYPES as readonly string[]).includes(type)) throw new BadRequestException('type must be subcategory or main_change');
  const name = str(body?.name);
  if (name.length < 2 || name.length > 50) throw new BadRequestException('Name must be 2 to 50 characters.');
  const reason = str(body?.reason);
  if (reason.length < 10 || reason.length > 500) throw new BadRequestException('Reason must be 10 to 500 characters.');
  const exampleProduct = str(body?.exampleProduct);
  if (exampleProduct.length < 2 || exampleProduct.length > 120) throw new BadRequestException('Add one example product (2 to 120 characters).');
  return { type, name, reason, exampleProduct };
}

@Injectable()
export class CategoryRequestsService {
  constructor(
    @InjectModel(CategoryRequest.name) private readonly requests: Model<CategoryRequestDocument>,
    private readonly databaseService: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The seller must own the store: anyone else gets 403 (read AND create). Returns the store. */
  private async ownedStore(sellerId: string, storeId: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid store id');
    const store: any = await this.databaseService.repositories.storeModel
      .findOne({ _id: storeId, sellerId, isDelete: false }).select('_id categoryId name').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  async create(sellerId: string, storeId: string, body: RequestInput) {
    const store = await this.ownedStore(sellerId, storeId);
    const input = cleanRequestInput(body);
    const pendingFilter = { storeId, status: 'pending' };
    const pending = await this.requests.countDocuments(pendingFilter);
    const limitMsg = `You already have ${MAX_PENDING_REQUESTS_PER_STORE} requests waiting for review. Wait for Edudeen to answer one before sending another.`;
    if (pending >= MAX_PENDING_REQUESTS_PER_STORE) throw new BadRequestException(limitMsg);
    const dup = await this.requests.exists({ ...pendingFilter, type: input.type, name: new RegExp(`^${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (dup) throw new BadRequestException('You already have a pending request with this name.');
    const doc = await this.requests.create({ storeId, sellerId, ...input, mainCategoryId: store.categoryId ? String(store.categoryId) : null });
    // Two quick clicks can both pass the count above; re-check after insert and withdraw the extra one.
    // Only withdraw THIS one if it is not among the oldest N pending (ordered by _id): parallel requests then
    // keep exactly N instead of all deleting themselves.
    const keep = await this.requests.find(pendingFilter).sort({ _id: 1 }).limit(MAX_PENDING_REQUESTS_PER_STORE).select('_id').lean();
    if (!keep.some((k: any) => String(k._id) === String(doc._id))) {
      await this.requests.deleteOne({ _id: doc._id });
      throw new BadRequestException(limitMsg);
    }
    void this.activityLog.log({
      storeId, category: 'settings', action: 'category_request_created', description: `Requested ${input.type === 'main_change' ? 'a main category change' : 'a subcategory'}: ${input.name}`,
      actorId: sellerId, actorRole: 'seller', targetId: String(doc._id), targetType: 'category_request',
    });
    return { success: true, data: this.view(doc.toObject()) };
  }

  async listForStore(sellerId: string, storeId: string) {
    await this.ownedStore(sellerId, storeId);
    const rows = await this.requests.find({ storeId }).sort({ createdAt: -1 }).limit(50).lean();
    return { success: true, data: rows.map((r) => this.view(r)), pendingLimit: MAX_PENDING_REQUESTS_PER_STORE };
  }

  private view(r: any) {
    return {
      _id: String(r._id), storeId: r.storeId, type: r.type, name: r.name, reason: r.reason, exampleProduct: r.exampleProduct,
      status: r.status, adminNote: r.adminNote ?? null, reviewedAt: r.reviewedAt ?? null, createdAt: r.createdAt,
    };
  }

  // ── Admin ───────────────────────────────────────────────────────────────
  async adminList(status: string | undefined, page = 1, limit = 25) {
    if (status && !['pending', 'approved', 'rejected'].includes(status)) throw new BadRequestException('Invalid status');
    const filter: any = status ? { status } : {};
    const p = Math.max(1, Math.floor(Number(page)) || 1);
    const l = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 25));
    const [rows, total, pendingCount] = await Promise.all([
      this.requests.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      this.requests.countDocuments(filter),
      this.requests.countDocuments({ status: 'pending' }),
    ]);
    const storeIds = [...new Set(rows.map((r: any) => r.storeId))].filter((id) => isValidObjectId(id));
    const stores: any[] = storeIds.length ? await this.databaseService.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name').lean() : [];
    const names = new Map(stores.map((s) => [String(s._id), s.name]));
    const catIds = [...new Set(rows.map((r: any) => r.mainCategoryId).filter((id: any) => id && isValidObjectId(id)))];
    const cats: any[] = catIds.length ? await this.databaseService.repositories.categoryModel.find({ _id: { $in: catIds } }).select('name').lean() : [];
    const catNames = new Map(cats.map((c) => [String(c._id), c.name]));
    return {
      success: true, pendingCount,
      data: rows.map((r: any) => ({ ...this.view(r), storeName: names.get(r.storeId) ?? null, mainCategoryName: r.mainCategoryId ? catNames.get(r.mainCategoryId) ?? null : null })),
      pagination: { page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) },
    };
  }

  /**
   * Approve / reject. Status-guarded (only `pending` can change) so two admins cannot both decide.
   * Approving does NOT create the category: the admin adds it with the normal tools, then marks this approved.
   */
  async decide(id: string, status: 'approved' | 'rejected', note: unknown, meta: { adminId: string; ip?: string; userAgent?: string }) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid request id');
    if (status !== 'approved' && status !== 'rejected') throw new BadRequestException('status must be approved or rejected');
    const adminNote = str(note).slice(0, 500);
    if (status === 'rejected' && adminNote.length < 10) throw new BadRequestException('Tell the seller why (at least 10 characters).');
    const row: any = await this.requests.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status, adminNote: adminNote || null, reviewedBy: meta.adminId, reviewedAt: new Date() } },
      { new: true },
    ).lean();
    if (!row) {
      const exists = await this.requests.exists({ _id: id });
      if (!exists) throw new NotFoundException('Request not found');
      throw new ConflictException('This request was already reviewed.');
    }
    const logged = await this.activityLog.log({
      storeId: 'platform', category: 'settings', action: `category_request_${status}`,
      description: `${status === 'approved' ? 'Approved' : 'Rejected'} category request "${row.name}" (${row.type})`,
      actorId: meta.adminId, actorRole: 'admin', targetId: String(row._id), targetType: 'category_request',
      ip: meta.ip, userAgent: meta.userAgent, metadata: { storeId: row.storeId, type: row.type, note: adminNote || null },
    });
    if (!logged) {
      // Audit is mandatory: put the request back so the decision can be repeated with a log entry.
      await this.requests.updateOne({ _id: id, status, reviewedBy: meta.adminId }, { $set: { status: 'pending', adminNote: null, reviewedBy: null, reviewedAt: null } });
      throw new ConflictException('Could not record the decision in the activity log. Nothing was changed; try again.');
    }
    const kind = row.type === 'main_change' ? 'main category change' : 'subcategory';
    const title = status === 'approved' ? `Your ${kind} request was approved` : `Your ${kind} request was not approved`;
    const bodyText = status === 'approved'
      ? `"${row.name}" was approved.${adminNote ? ` Note from Edudeen: ${adminNote}` : ''} It will appear in your category list once the Edudeen team has added it.`
      : `"${row.name}" was not approved. Reason: ${adminNote}`;
    void this.notifications.notify({
      recipientId: String(row.sellerId), recipientRole: 'seller',
      type: status === 'approved' ? NOTIFICATION_TYPES.CATEGORY_REQUEST_APPROVED : NOTIFICATION_TYPES.CATEGORY_REQUEST_REJECTED,
      title, body: bodyText, data: { storeId: row.storeId, link: `/store/${row.storeId}/categories` },
    });
    return { success: true, data: this.view(row) };
  }

  // ── Seller: product counts per category (same filter as the Products page) ─────────────
  /**
   * For every category that has at least one of THIS store's products: active / draft / total, where a product
   * counts for a category when that category is the product's category, sub-category or an ancestor of either
   * (exactly what `?category=<id>` on the Products list matches). Also how many products have no sub-category.
   */
  async storeUsage(sellerId: string, storeId: string) {
    await this.ownedStore(sellerId, storeId);
    const rows: any[] = await this.databaseService.repositories.productModel
      .find({ storeId, sellerId, isDelete: false }).select('categoryId subCategoryId status').lean();
    return { success: true, data: await buildStoreUsage(rows, (id) => getAncestorChain(this.databaseService.repositories.categoryModel as any, id)) };
  }
}

export interface UsageCount { active: number; draft: number; total: number }

/** Pure-ish roll-up (chain lookup injected) so it can be tested without a database. */
export async function buildStoreUsage(rows: { categoryId?: any; subCategoryId?: any; status?: string }[], chainOf: (id: string) => Promise<string[]>) {
  const counts: Record<string, UsageCount> = {};
  const chainCache = new Map<string, string[]>();
  const chain = async (id: string) => {
    let c = chainCache.get(id);
    if (!c) { c = await chainOf(id); chainCache.set(id, c); }
    return c;
  };
  let noSubcategory = 0;
  for (const p of rows) {
    const ids = new Set<string>();
    for (const raw of [p.categoryId, p.subCategoryId]) if (raw) for (const x of await chain(String(raw))) ids.add(x);
    const isActive = p.status === 'active' || p.status === 'scheduled';
    const isDraft = p.status === 'draft';
    for (const id of ids) {
      const c = (counts[id] ??= { active: 0, draft: 0, total: 0 });
      c.total++;
      if (isActive) c.active++;
      if (isDraft) c.draft++;
    }
    if (!p.subCategoryId) noSubcategory++;
  }
  return { counts, noSubcategory };
}
