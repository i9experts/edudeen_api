/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SeoResolutionService } from './seo-resolution.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { UpdateStoreChecklistItemDto } from '../dto/update-store-checklist.dto';
import { assertSafeSeoDestination, pickSeoMeta } from './seo-url-safety.util';
import { computeSeoCompleteness } from './seo-content.service';

// Manual checklist items a seller ticks themselves — the automated ones
// (https_enabled, meta_title_set, etc.) are derived at read time instead of
// stored, so they can never go stale relative to the store's actual data.
const MANUAL_CHECKLIST_ITEMS = ['sitemap_submitted', 'search_console_verified', 'social_profiles_linked'];

/**
 * Seller-facing store SEO — dashboard, store-level meta, and the Technical
 * Checklist. The full rule-based audit score (SeoAuditService) lands in
 * Phase 8; the dashboard here surfaces a lightweight completeness view in
 * the meantime so the endpoint isn't empty while that's built.
 */
@Injectable()
export class StoreSeoService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly resolution: SeoResolutionService,
  ) {}

  async getDashboard(storeId: string) {
    const [store, productCount, productsWithSeo] = await Promise.all([
      this.db.repositories.storeModel.findById(storeId).lean(),
      this.db.repositories.productModel.countDocuments({ storeId, isDelete: false }),
      this.db.repositories.productModel.find({ storeId, isDelete: false }).select('seo').lean(),
    ]);
    if (!store) throw new NotFoundException('Store not found.');

    const storeCompleteness = computeSeoCompleteness((store as any).seo);
    const productCompletenessAvg = productsWithSeo.length
      ? Math.round((productsWithSeo as any[]).reduce((sum, p) => sum + computeSeoCompleteness(p.seo), 0) / productsWithSeo.length)
      : 0;
    const checklist = await this.getChecklist(storeId);
    const checklistCompletion = checklist.length ? Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100) : 0;

    return {
      storeCompleteness,
      productCompletenessAvg,
      productCount,
      checklistCompletion,
      checklist,
    };
  }

  async getStoreSeo(storeId: string) {
    const store = await this.db.repositories.storeModel.findById(storeId).lean();
    if (!store) throw new NotFoundException('Store not found.');
    return (store as any).seo ?? {};
  }

  async updateStoreSeo(storeId: string, dto: UpdateSeoMetaDto, actor: { id: string; name?: string; role?: string }) {
    if (dto.canonicalUrlOverride) assertSafeSeoDestination(dto.canonicalUrlOverride);

    const store = await this.db.repositories.storeModel.findById(storeId);
    if (!store) throw new NotFoundException('Store not found.');

    const current = (store as any).seo?.toObject?.() ?? (store as any).seo ?? {};
    (store as any).seo = { ...current, ...pickSeoMeta(dto as unknown as Record<string, unknown>), aiGenerated: false, updatedAt: new Date() };
    await store.save();

    await this.resolution.invalidate('store', storeId);

    await this.activityLog.log({
      storeId, category: 'seo', action: 'store_seo_updated',
      description: 'Store SEO meta updated',
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: storeId, targetType: 'store_seo',
    });

    return store.toObject().seo;
  }

  async getChecklist(storeId: string) {
    const store = await this.db.repositories.storeModel.findById(storeId).lean();
    if (!store) throw new NotFoundException('Store not found.');

    const seo = (store as any).seo ?? {};
    const manualState = new Map((seo.checklist ?? []).map((c: any) => [c.key, c]));

    const automated = [
      { key: 'meta_title_set', done: !!seo.metaTitle, automated: true },
      { key: 'meta_description_set', done: !!seo.metaDescription, automated: true },
      { key: 'has_logo', done: !!(store as any).logo, automated: true },
      { key: 'has_custom_domain', done: !!(store as any).customDomain, automated: true },
    ];
    const manual = MANUAL_CHECKLIST_ITEMS.map((key) => ({
      key,
      done: !!(manualState.get(key) as any)?.done,
      automated: false,
    }));

    return [...automated, ...manual];
  }

  async updateChecklistItem(storeId: string, dto: UpdateStoreChecklistItemDto, actor: { id: string; name?: string; role?: string }) {
    if (!MANUAL_CHECKLIST_ITEMS.includes(dto.key)) {
      throw new NotFoundException(`"${dto.key}" is not a manually-editable checklist item (it may be automatically derived).`);
    }

    const store = await this.db.repositories.storeModel.findById(storeId);
    if (!store) throw new NotFoundException('Store not found.');

    const seo: any = (store as any).seo ?? {};
    const checklist: any[] = seo.checklist ?? [];
    const existingIndex = checklist.findIndex((c) => c.key === dto.key);
    const entry = { key: dto.key, done: dto.done, completedAt: dto.done ? new Date() : null };
    if (existingIndex >= 0) checklist[existingIndex] = entry; else checklist.push(entry);
    seo.checklist = checklist;
    (store as any).seo = seo;
    await store.save();

    await this.activityLog.log({
      storeId, category: 'seo', action: 'store_seo_checklist_updated',
      description: `Checklist item "${dto.key}" marked ${dto.done ? 'done' : 'not done'}`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetType: 'store_seo_checklist',
    });

    return this.getChecklist(storeId);
  }
}
