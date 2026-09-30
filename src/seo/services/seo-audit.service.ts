/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { QUEUE_NAMES, SEO_AUDIT_RUN_JOB } from 'src/queues/queue.constants';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { PlatformSeoService } from './platform-seo-settings.service';
import { StoreSeoService } from './store-seo.service';

interface AuditIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  entityType?: 'product' | 'category' | 'store' | null;
  entityId?: string | null;
}

const SEVERITY_WEIGHT: Record<string, number> = { info: 1, warning: 3, error: 6 };

/**
 * Fixed, code-defined audit checks whose *thresholds* come from
 * `PlatformSeoSettings.rules` — see architecture plan Refinement #3 (NOT a
 * generic data-driven rule engine; the check logic itself is code, only the
 * numbers are configurable). Several checks are honest approximations given
 * what this codebase's data model actually stores (no per-image alt-text
 * field exists, for instance) — documented inline rather than overclaiming.
 */
@Injectable()
export class SeoAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly platformSeoService: PlatformSeoService,
    private readonly storeSeoService: StoreSeoService,
    private readonly entitlements: EntitlementsService,
    @InjectQueue(QUEUE_NAMES.SEO_AUDIT) private readonly auditQueue: Queue,
  ) {}

  async enqueueRun(storeId: string): Promise<{ queued: true }> {
    // One audit per store per 5-minute window: BullMQ ignores a job whose id already exists, so repeated clicks (or a
    // script) can't stack thousands of full-catalogue audits. The time bucket keeps completed jobs from blocking
    // the next legitimate run forever.
    const bucket = Math.floor(Date.now() / (5 * 60_000));
    await this.auditQueue.add(SEO_AUDIT_RUN_JOB, { storeId }, { jobId: `seo-audit-${storeId}-${bucket}` });
    return { queued: true };
  }

  /** Called by the daily `runScheduledSeoAudits` cron — only for stores whose platform plan includes `advancedSeoToolsAllowed`. */
  async enqueueScheduledRuns(): Promise<{ queued: number }> {
    const activeStores = await this.db.repositories.storeModel.find({ status: 'active', isDelete: false }).select('_id').lean();
    let queued = 0;
    for (const store of activeStores as any[]) {
      const limits = await this.entitlements.getLimits(store._id.toString());
      if (limits.advancedSeoToolsAllowed) {
        await this.enqueueRun(store._id.toString());
        queued++;
      }
    }
    return { queued };
  }

  async getLatest(storeId: string) {
    const latest = await this.db.repositories.seoAuditResultModel.findOne({ storeId }).sort({ runAt: -1 }).lean();
    if (!latest) throw new NotFoundException('No audit has been run for this store yet — run one first.');
    return latest;
  }

  async getHistory(storeId: string, query: { page?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    const filter = { storeId };

    const [items, total] = await Promise.all([
      this.db.repositories.seoAuditResultModel.find(filter).select('score runAt checklistCompletionPercent').sort({ runAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.db.repositories.seoAuditResultModel.countDocuments(filter),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** Invoked by SeoAuditProcessor — runs every enabled built-in check against the store's products + store meta, scores the result, and persists it. */
  async run(storeId: string) {
    const [settings, store, products, checklist] = await Promise.all([
      this.platformSeoService.getSettings(),
      this.db.repositories.storeModel.findById(storeId).lean(),
      this.db.repositories.productModel.find({ storeId, isDelete: false }).lean(),
      this.storeSeoService.getChecklist(storeId),
    ]);
    if (!store) throw new NotFoundException('Store not found.');

    const enabledRules = new Map(settings.rules?.map((r: any) => [r.code, r]) ?? []);
    const isEnabled = (code: string) => (enabledRules.get(code))?.enabled ?? true;
    const threshold = (code: string, key: string, fallback: number) => (enabledRules.get(code))?.thresholds?.[key] ?? fallback;
    const severityOf = (code: string, fallback: 'info' | 'warning' | 'error') => (enabledRules.get(code))?.severity ?? fallback;

    const issues: AuditIssue[] = [];
    const titleCounts = new Map<string, string[]>(); // for duplicate_meta

    for (const product of products as any[]) {
      const seo = product.seo ?? {};
      const productRef = { entityType: 'product' as const, entityId: product._id.toString() };

      if (isEnabled('title_length')) {
        const max = threshold('title_length', 'max', 60);
        if (!seo.metaTitle) {
          issues.push({ severity: severityOf('title_length', 'warning'), code: 'title_length', message: `Product "${product.name}" has no meta title.`, ...productRef });
        } else if (seo.metaTitle.length > max) {
          issues.push({ severity: severityOf('title_length', 'warning'), code: 'title_length', message: `Product "${product.name}" meta title exceeds ${max} characters.`, ...productRef });
        }
      }

      if (isEnabled('description_length')) {
        const min = threshold('description_length', 'min', 70);
        const max = threshold('description_length', 'max', 160);
        if (!seo.metaDescription) {
          issues.push({ severity: severityOf('description_length', 'warning'), code: 'description_length', message: `Product "${product.name}" has no meta description.`, ...productRef });
        } else if (seo.metaDescription.length < min || seo.metaDescription.length > max) {
          issues.push({ severity: severityOf('description_length', 'info'), code: 'description_length', message: `Product "${product.name}" meta description is outside the ideal ${min}-${max} character range.`, ...productRef });
        }
      }

      // No per-image alt-text field exists in this codebase's Product schema
      // (images are plain URL strings) — approximated as "has no images at
      // all", which is the closest real signal this data model can offer.
      if (isEnabled('missing_alt_text') && (!product.images || product.images.length === 0)) {
        issues.push({ severity: severityOf('missing_alt_text', 'warning'), code: 'missing_alt_text', message: `Product "${product.name}" has no images (no alt-text opportunity, weaker image-search visibility).`, ...productRef });
      }

      if (isEnabled('thin_content')) {
        const minWords = threshold('thin_content', 'minChars', 100);
        if ((product.description?.length ?? 0) < minWords) {
          issues.push({ severity: severityOf('thin_content', 'warning'), code: 'thin_content', message: `Product "${product.name}" description is thin (under ${minWords} characters) — may read as low-value content to search engines.`, ...productRef });
        }
      }

      // Product JSON-LD (SeoSchemaGeneratorService) needs a non-empty `image`
      // array to be eligible for Google's rich product results.
      if (isEnabled('missing_schema') && (!product.images || product.images.length === 0)) {
        issues.push({ severity: severityOf('missing_schema', 'info'), code: 'missing_schema', message: `Product "${product.name}" has no images, so its structured data won't qualify for rich results.`, ...productRef });
      }

      if (seo.metaTitle) {
        const list = titleCounts.get(seo.metaTitle) ?? [];
        list.push(product._id.toString());
        titleCounts.set(seo.metaTitle, list);
      }
    }

    if (isEnabled('duplicate_meta')) {
      for (const [title, ids] of titleCounts) {
        if (ids.length > 1) {
          issues.push({ severity: severityOf('duplicate_meta', 'warning'), code: 'duplicate_meta', message: `${ids.length} products share the identical meta title "${title}".`, entityType: 'product', entityId: ids[0] });
        }
      }
    }

    // missing_canonical / broken_internal_link — validate any manually-set
    // canonicalUrlOverride still points at a real product in this store
    // (the only "internal link" surface sellers can currently author here).
    if (isEnabled('missing_canonical') || isEnabled('broken_internal_link')) {
      const slugToProduct = new Map((products as any[]).map((p) => [p.slug, p]));
      for (const product of products as any[]) {
        const override: string | undefined = product.seo?.canonicalUrlOverride;
        if (!override) continue;
        const match = override.match(/\/product\/([^/?#]+)/);
        if (match && !slugToProduct.has(match[1])) {
          issues.push({ severity: severityOf('broken_internal_link', 'error'), code: 'broken_internal_link', message: `Product "${product.name}"'s canonical override points at a slug that no longer exists.`, entityType: 'product', entityId: product._id.toString() });
        }
      }
    }

    const storeSeo = (store as any).seo ?? {};
    if (isEnabled('title_length') && !storeSeo.metaTitle) {
      issues.push({ severity: 'warning', code: 'title_length', message: 'Store has no meta title set.', entityType: 'store', entityId: storeId });
    }
    if (isEnabled('description_length') && !storeSeo.metaDescription) {
      issues.push({ severity: 'warning', code: 'description_length', message: 'Store has no meta description set.', entityType: 'store', entityId: storeId });
    }

    const checklistCompletionPercent = checklist.length ? Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100) : 0;
    const score = computeScore(issues, checklistCompletionPercent);

    const result = await this.db.repositories.seoAuditResultModel.create({
      storeId, score, issues, checklistCompletionPercent, runAt: new Date(),
    });

    await this.activityLog.log({
      storeId, category: 'seo', action: 'seo_audit_run',
      description: `SEO audit run — score ${score}, ${issues.length} issue(s)`,
      targetType: 'seo_audit',
    });

    return result;
  }
}

function computeScore(issues: AuditIssue[], checklistCompletionPercent: number): number {
  const deduction = issues.reduce((sum, issue) => sum + (SEVERITY_WEIGHT[issue.severity] ?? 1), 0);
  const contentScore = Math.max(0, 100 - deduction);
  // Weighted blend: content issues matter most, checklist completion is a smaller factor.
  return Math.round(contentScore * 0.8 + checklistCompletionPercent * 0.2);
}
