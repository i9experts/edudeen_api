/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SeoResolutionService } from './seo-resolution.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { assertSafeSeoDestination, pickSeoMeta } from './seo-url-safety.util';
import { toCsv } from 'src/analytics/utils/csv.util';

import { clampInt } from 'src/common/query-safety.util';
/**
 * Manages the embedded `.seo` field on content entities. Category methods
 * live here from Phase 2 (admin-only, root categories are admin-curated
 * anyway); Product/Store/Page methods are added in Phase 7 for the seller
 * side — same service, same cache-invalidation discipline, so content SEO
 * logic isn't duplicated per entity type.
 */
@Injectable()
export class SeoContentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly resolution: SeoResolutionService,
  ) {}

  async getCategorySeo(categoryId: string) {
    const category = await this.db.repositories.categoryModel.findById(categoryId).lean();
    if (!category) throw new NotFoundException('Category not found.');
    return (category as any).seo ?? {};
  }

  async updateCategorySeo(categoryId: string, dto: UpdateSeoMetaDto, actor: { id: string; name?: string; role?: string }) {
    if (dto.canonicalUrlOverride) assertSafeSeoDestination(dto.canonicalUrlOverride);

    const category = await this.db.repositories.categoryModel.findById(categoryId);
    if (!category || (category as any).isDelete) throw new NotFoundException('Category not found.');

    const merged = { ...(category as any).seo?.toObject?.() ?? (category as any).seo, ...pickSeoMeta(dto as unknown as Record<string, unknown>), updatedAt: new Date() };
    (category as any).seo = merged;
    await category.save();

    await this.resolution.invalidate('category', categoryId);

    await this.activityLog.log({
      category: 'seo',
      action: 'category_seo_updated',
      description: `SEO meta updated for category "${(category as any).name}"`,
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: categoryId,
      targetType: 'category_seo',
    });

    return merged;
  }

  /**
   * Resolves the context an AI provider (or a seller preview) needs to
   * generate a suggestion, plus the store/seller pair used for ownership
   * checks and entitlement/credit-wallet lookups. Product context includes
   * its category/store names; category/store need no further lookup.
   */
  async getEntityContext(entityType: 'product' | 'category' | 'store', entityId: string) {
    if (entityType === 'product') {
      const product = await this.db.repositories.productModel.findById(entityId).lean();
      if (!product) throw new NotFoundException('Product not found.');
      const [category, store] = await Promise.all([
        (product as any).categoryId ? this.db.repositories.categoryModel.findById((product as any).categoryId).lean() : null,
        this.db.repositories.storeModel.findById((product as any).storeId).lean(),
      ]);
      return {
        name: (product as any).name,
        description: (product as any).description ?? null,
        categoryName: (category as any)?.name ?? null,
        storeName: (store as any)?.name ?? null,
        storeId: (product as any).storeId,
        sellerId: (product as any).sellerId,
      };
    }
    if (entityType === 'category') {
      const category = await this.db.repositories.categoryModel.findById(entityId).lean();
      if (!category) throw new NotFoundException('Category not found.');
      return { name: (category as any).name, description: (category as any).description ?? null, categoryName: null, storeName: null, storeId: null, sellerId: null };
    }
    const store = await this.db.repositories.storeModel.findById(entityId).lean();
    if (!store) throw new NotFoundException('Store not found.');
    return {
      name: (store as any).name,
      description: (store as any).description ?? null,
      categoryName: null,
      storeName: null,
      storeId: (store as any)._id.toString(),
      sellerId: (store as any).sellerId,
    };
  }

  /** Writes an AI-generated (or seller-authored) suggestion onto the entity's `.seo`, marking `aiGenerated` appropriately, and busts the resolution cache. */
  async applySeoSuggestion(
    entityType: 'product' | 'category' | 'store',
    entityId: string,
    fields: { metaTitle?: string; metaDescription?: string; keywords?: string[] },
    aiGenerated: boolean,
  ) {
    // Branched explicitly (rather than a union-typed `model` variable) —
    // Mongoose's `findById` overload set isn't compatible across distinct
    // Model<T> types, so a union variable fails to type-check.
    const doc: any = entityType === 'product'
      ? await this.db.repositories.productModel.findById(entityId)
      : entityType === 'category'
        ? await this.db.repositories.categoryModel.findById(entityId)
        : await this.db.repositories.storeModel.findById(entityId);
    if (!doc) throw new NotFoundException(`${entityType} not found.`);

    const current = (doc).seo?.toObject?.() ?? (doc).seo ?? {};
    (doc).seo = { ...current, ...fields, aiGenerated, updatedAt: new Date() };
    await doc.save();

    await this.resolution.invalidate(entityType, entityId);
  }

  // ── Seller-facing: Product SEO (Phase 7) ─────────────────────────────────

  async listProductSeo(storeId: string, query: { page?: number; limit?: number }) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, Math.max(1, clampInt(query.limit, 20, 1, 100)));
    const filter = { storeId, isDelete: false };

    const [items, total] = await Promise.all([
      this.db.repositories.productModel.find(filter).select('name slug seo').sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.db.repositories.productModel.countDocuments(filter),
    ]);

    const withCompleteness = items.map((p: any) => ({
      _id: p._id, name: p.name, slug: p.slug, seo: p.seo ?? {},
      completeness: computeSeoCompleteness(p.seo),
    }));
    return { items: withCompleteness, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getProductSeo(storeId: string, productId: string) {
    const product = await this.db.repositories.productModel.findOne({ _id: productId, storeId, isDelete: false }).lean();
    if (!product) throw new NotFoundException('Product not found.');
    return (product as any).seo ?? {};
  }

  async updateProductSeo(storeId: string, productId: string, dto: UpdateSeoMetaDto, actor: { id: string; name?: string; role?: string }) {
    if (dto.canonicalUrlOverride) assertSafeSeoDestination(dto.canonicalUrlOverride);

    const product = await this.db.repositories.productModel.findOne({ _id: productId, storeId, isDelete: false });
    if (!product) throw new NotFoundException('Product not found.');

    const merged = { ...(product as any).seo?.toObject?.() ?? (product as any).seo, ...pickSeoMeta(dto as unknown as Record<string, unknown>), aiGenerated: false, updatedAt: new Date() };
    (product as any).seo = merged;
    await product.save();

    await this.resolution.invalidate('product', productId);

    await this.activityLog.log({
      storeId, category: 'seo', action: 'product_seo_updated',
      description: `SEO meta updated for product "${(product as any).name}"`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: productId, targetType: 'product_seo',
    });

    return merged;
  }

  /** Applies a token-templated title/description to every product matching the filter — real business value at catalog scale (see architecture plan Refinement #4). */
  async bulkApplyProductTemplate(
    storeId: string,
    template: { titleTemplate?: string; descriptionTemplate?: string; categoryId?: string; onlyMissing?: boolean },
    actor: { id: string; name?: string; role?: string },
  ): Promise<{ updated: number }> {
    const filter: Record<string, any> = { storeId, isDelete: false };
    if (template.categoryId) filter.categoryId = template.categoryId;
    if (template.onlyMissing) filter['seo.metaTitle'] = { $in: [null, undefined, ''] };

    const products = await this.db.repositories.productModel.find(filter).lean();
    let updated = 0;
    for (const product of products as any[]) {
      const metaTitle = template.titleTemplate ? renderProductTemplate(template.titleTemplate, product) : product.seo?.metaTitle;
      const metaDescription = template.descriptionTemplate ? renderProductTemplate(template.descriptionTemplate, product) : product.seo?.metaDescription;
      await this.db.repositories.productModel.updateOne(
        { _id: product._id },
        { $set: { 'seo.metaTitle': metaTitle, 'seo.metaDescription': metaDescription, 'seo.updatedAt': new Date() } },
      );
      await this.resolution.invalidate('product', product._id.toString());
      updated++;
    }

    await this.activityLog.log({
      storeId, category: 'seo', action: 'product_seo_bulk_applied',
      description: `Bulk SEO template applied to ${updated} products`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetType: 'product_seo_bulk',
      metadata: { updated, ...template },
    });

    return { updated };
  }

  async exportProductSeoCsv(storeId: string): Promise<string> {
    const products = await this.db.repositories.productModel.find({ storeId, isDelete: false }).select('name slug seo').lean();
    const headers = ['Product', 'Slug', 'Meta Title', 'Meta Description', 'Keywords', 'Noindex', 'AI Generated', 'Completeness %'];
    const rows = (products as any[]).map((p) => [
      p.name, p.slug, p.seo?.metaTitle ?? '', p.seo?.metaDescription ?? '', (p.seo?.keywords ?? []).join('; '),
      p.seo?.noindex ? 'yes' : 'no', p.seo?.aiGenerated ? 'yes' : 'no', computeSeoCompleteness(p.seo),
    ]);
    return toCsv(headers, rows);
  }

  // ── Seller-facing: read-only category view (Phase 7) ─────────────────────

  async listStoreCategoriesSeo(storeId: string) {
    const store = await this.db.repositories.storeModel.findById(storeId).lean();
    if (!store) throw new NotFoundException('Store not found.');
    const categoryIds = new Set<string>();
    if ((store as any).categoryId) categoryIds.add((store as any).categoryId);

    const products = await this.db.repositories.productModel.find({ storeId, isDelete: false }).select('subCategoryId').lean();
    for (const p of products as any[]) if (p.subCategoryId) categoryIds.add(p.subCategoryId);

    return this.db.repositories.categoryModel.find({ _id: { $in: [...categoryIds] } }).select('name seo').lean();
  }

  // ── Seller-facing: Store page-builder pages SEO (Phase 7) ─────────────────

  async getPageSeo(storeId: string, pageId: string) {
    const store = await this.db.repositories.storeModel.findById(storeId).lean();
    if (!store) throw new NotFoundException('Store not found.');
    return (store as any).seo?.pages?.[pageId] ?? {};
  }

  async updatePageSeo(storeId: string, pageId: string, dto: { metaTitle?: string; metaDescription?: string; ogImage?: string; noindex?: boolean }, actor: { id: string; name?: string; role?: string }) {
    const store = await this.db.repositories.storeModel.findById(storeId);
    if (!store) throw new NotFoundException('Store not found.');

    const seo = (store as any).seo ?? {};
    if (!/^[a-f0-9]{24}$/i.test(pageId)) throw new BadRequestException('Invalid page id.');
    seo.pages = { ...(seo.pages ?? {}), [pageId]: { ...(seo.pages?.[pageId] ?? {}), ...pickSeoMeta(dto as unknown as Record<string, unknown>) } };
    (store as any).seo = seo;
    await store.save();

    await this.activityLog.log({
      storeId, category: 'seo', action: 'page_seo_updated',
      description: `SEO meta updated for page "${pageId}"`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: pageId, targetType: 'page_seo',
    });

    return seo.pages[pageId];
  }
}

/** 0-100 heuristic: title present, description present, at least 3 keywords, has an image override. Used for the product-list completeness badge and CSV export — the full rule-based audit score lives in SeoAuditService (Phase 8). */
export function computeSeoCompleteness(seo: any): number {
  if (!seo) return 0;
  let score = 0;
  if (seo.metaTitle) score += 35;
  if (seo.metaDescription) score += 35;
  if (seo.keywords?.length >= 3) score += 20;
  if (seo.ogImage) score += 10;
  return score;
}

function renderProductTemplate(template: string, product: any): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (key === 'productName') return product.name ?? '';
    return '';
  });
}
