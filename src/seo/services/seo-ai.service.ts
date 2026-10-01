/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { AiCreditsService } from 'src/platform-plans/ai-credits.service';
import { QUEUE_NAMES, SEO_AI_GENERATE_BULK_JOB } from 'src/queues/queue.constants';
import { SeoContentService } from './seo-content.service';
import { AnthropicSeoAiProvider } from '../providers/anthropic-seo-ai.provider';
import { PlatformSeoService } from './platform-seo-settings.service';

import { clampInt } from 'src/common/query-safety.util';
export const AI_SEO_SUGGESTION_CREDIT_COST = 5;

/**
 * Orchestrates `ISeoAiProvider` (currently `AnthropicSeoAiProvider`, selected
 * structurally here rather than via an `AI_SEO_PROVIDER` env switch since
 * there's only one implementation today — swapping providers later means
 * changing this one constructor injection, not any call site). Every
 * generation: verifies store ownership + `seoAiSuggestionsAllowed`
 * entitlement + the platform-wide AI SEO kill switch, deducts
 * `AiCreditsWallet` credits, calls the provider, writes the result via
 * `SeoContentService.applySeoSuggestion`, and logs a `SeoAiSuggestionLog` row.
 *
 * Category entities are intentionally out of scope here — categories are
 * admin-curated (see master doc §5.2) and have no per-store credit wallet to
 * charge against; AI suggestions only apply to seller-owned products/stores.
 */
@Injectable()
export class SeoAiService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly entitlements: EntitlementsService,
    private readonly aiCredits: AiCreditsService,
    private readonly seoContent: SeoContentService,
    private readonly aiProvider: AnthropicSeoAiProvider,
    private readonly platformSeoService: PlatformSeoService,
    @InjectQueue(QUEUE_NAMES.SEO_AI) private readonly seoAiQueue: Queue,
  ) {}

  async generate(
    entityType: 'product' | 'category' | 'store',
    entityId: string,
    sellerId: string,
    actor: { id: string; name?: string; role?: string },
  ) {
    if (entityType === 'category') {
      throw new BadRequestException('AI SEO suggestions are not available for platform categories.');
    }

    const settings = await this.platformSeoService.getSettings();
    if (!settings.aiSeoEnabled) {
      throw new ForbiddenException('AI SEO is currently disabled platform-wide.');
    }

    const context = await this.seoContent.getEntityContext(entityType, entityId);
    if (context.sellerId !== sellerId) {
      throw new ForbiddenException('You do not own this resource.');
    }
    const storeId = context.storeId as string;

    await this.entitlements.assertFeatureAllowed(storeId, 'seoAiSuggestionsAllowed', 'AI-generated SEO suggestions');
    await this.aiCredits.deduct(storeId, sellerId, AI_SEO_SUGGESTION_CREDIT_COST, `AI SEO suggestion — ${entityType} ${entityId}`);

    // Credits were taken up front; if the provider (or applying its result) fails, the
    // seller must not pay for nothing — give them back before surfacing the error.
    let suggestion;
    try {
      suggestion = await this.aiProvider.generateSuggestion({
        entityType,
        name: context.name,
        description: context.description,
        categoryName: context.categoryName,
        storeName: context.storeName,
      });

      await this.seoContent.applySeoSuggestion(entityType, entityId, suggestion, true);
    } catch (err) {
      await this.aiCredits
        .grant(storeId, sellerId, AI_SEO_SUGGESTION_CREDIT_COST, `AI SEO suggestion refund — generation failed (${entityType} ${entityId})`)
        .catch(() => undefined);
      throw err;
    }

    await this.db.repositories.seoAiSuggestionLogModel.create({
      storeId, sellerId, entityType, entityId, suggestion, accepted: true, creditsCost: AI_SEO_SUGGESTION_CREDIT_COST,
    });

    await this.activityLog.log({
      storeId,
      category: 'seo',
      action: 'seo_ai_suggestion_generated',
      description: `AI SEO suggestion generated for ${entityType} "${context.name}"`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: entityId, targetType: `${entityType}_seo`,
      metadata: { creditsCost: AI_SEO_SUGGESTION_CREDIT_COST },
    });

    return suggestion;
  }

  async getSuggestionHistory(storeId: string, query: { page?: number; limit?: number }) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, Math.max(1, clampInt(query.limit, 20, 1, 100)));
    const filter = { storeId };

    const [items, total] = await Promise.all([
      this.db.repositories.seoAiSuggestionLogModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.db.repositories.seoAiSuggestionLogModel.countDocuments(filter),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** Enqueues bulk generation — never runs inline, since generating for many entities can take real time and must gracefully stop when the credit wallet runs out. */
  async enqueueBulkGenerate(
    entityType: 'product' | 'category' | 'store',
    entityIds: string[],
    storeId: string,
    sellerId: string,
    actor: { id: string; name?: string; role?: string },
  ) {
    if (entityType === 'category') {
      throw new BadRequestException('AI SEO suggestions are not available for platform categories.');
    }
    await this.entitlements.assertFeatureAllowed(storeId, 'seoAiSuggestionsAllowed', 'AI-generated SEO suggestions');

    const job = await this.seoAiQueue.add(SEO_AI_GENERATE_BULK_JOB, {
      entityType, entityIds, storeId, sellerId, actor,
    });
    return { queued: true, jobId: job.id };
  }
}
