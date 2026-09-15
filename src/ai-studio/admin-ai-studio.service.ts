/* eslint-disable prettier/prettier */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { AiCreditsService } from 'src/platform-plans/ai-credits.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { AiProviderError } from './providers/ai-provider.interfaces';
import { TextGenerationService } from './providers/text-generation.service';
import { KeywordDataService } from './providers/keyword-data.service';
import { ImageEnhanceService } from './providers/image-enhance.service';
import { AiToolType, AiGenerationScope } from './schemas/ai-generation.schema';
import {
  AdminGenerateSeoDto, AdminGenerateEmailDto, AdminGenerateImageEnhanceDto, AdjustWalletDto,
} from './dto/admin-generate.dto';
import {
  EMAIL_CAMPAIGN_SCHEMA, SEO_WRITING_SCHEMA, buildEmailCampaignPrompt, buildSeoWritingPrompt,
} from './tools/tool-definitions';

/**
 * Admin-facing counterpart to AiStudioService — two distinct responsibilities:
 *
 *  1. OVERSIGHT (read-only) — cross-store visibility into every seller's AI
 *     Studio usage: generations, credit transactions, wallet balances. Same
 *     collections the seller-side service already writes to; no new schemas
 *     needed for this half.
 *
 *  2. PLATFORM GENERATION — lets an admin run the SEO Booster / Email
 *     Campaigns / Image Enhancer tools for Edudeen's OWN marketplace content
 *     (landing pages, platform announcements, banners), NOT a seller's. These
 *     write `AiGeneration` rows with `scope: 'platform'` and `adminId` set,
 *     `storeId`/`sellerId` null, and never touch a seller's AiCreditsWallet —
 *     there is no per-generation charge for the platform's own usage. Only
 *     Listing Writer / Worksheet Builder / Price Optimizer are excluded here:
 *     they're inherently about a seller's product, which Edudeen itself
 *     doesn't have.
 */
@Injectable()
export class AdminAiStudioService {
  private readonly logger = new Logger(AdminAiStudioService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly aiCredits: AiCreditsService,
    private readonly activityLog: ActivityLogService,
    private readonly textGeneration: TextGenerationService,
    private readonly keywordData: KeywordDataService,
    private readonly imageEnhance: ImageEnhanceService,
  ) {}

  private get generationModel() { return this.db.repositories.aiGenerationModel; }
  private get txnModel() { return this.db.repositories.aiCreditTransactionModel; }
  private get walletModel() { return this.db.repositories.aiCreditsWalletModel; }

  // ============================================================ OVERSIGHT

  /** Platform-wide usage snapshot — generations, spend, success rate, adoption by tool. */
  async getOverview(days = 28) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [byToolStatus, spendAgg, topStores] = await Promise.all([
      this.generationModel.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { tool: '$toolType', status: '$status' }, count: { $sum: 1 } } },
      ]),
      this.txnModel.aggregate([
        { $match: { status: 'captured', createdAt: { $gte: since } } },
        { $group: { _id: null, totalCredits: { $sum: '$creditsCharged' }, count: { $sum: 1 } } },
      ]),
      this.generationModel.aggregate([
        { $match: { createdAt: { $gte: since }, scope: 'seller' } },
        { $group: { _id: '$storeId', generations: { $sum: 1 }, creditsCharged: { $sum: '$creditsCharged' } } },
        { $sort: { generations: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const byTool: Record<string, { succeeded: number; failed: number; processing: number }> = {};
    let totalGenerations = 0;
    let totalSucceeded = 0;
    for (const row of byToolStatus) {
      const tool = row._id.tool as string;
      const status = row._id.status as string;
      byTool[tool] ??= { succeeded: 0, failed: 0, processing: 0 };
      if (status in byTool[tool]) (byTool[tool] as any)[status] += row.count;
      totalGenerations += row.count;
      if (status === 'succeeded') totalSucceeded += row.count;
    }

    const storeIds = (topStores).map((r) => r._id).filter(Boolean);
    const stores = storeIds.length
      ? await this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean()
      : [];
    const storeById = new Map(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: {
        days,
        totalGenerations,
        successRate: totalGenerations > 0 ? Math.round((totalSucceeded / totalGenerations) * 100) : 0,
        totalCreditsSpent: (spendAgg[0])?.totalCredits ?? 0,
        capturedTransactionCount: (spendAgg[0])?.count ?? 0,
        byTool,
        topStores: (topStores).map((r) => ({
          storeId: r._id,
          storeName: storeById.get(r._id)?.name ?? null,
          storeSlug: storeById.get(r._id)?.slug ?? null,
          generations: r.generations,
          creditsCharged: r.creditsCharged,
        })),
      },
    };
  }

  async listGenerations(query: {
    scope?: AiGenerationScope; storeId?: string; sellerId?: string; toolType?: AiToolType;
    status?: string; page?: number; limit?: number;
  }) {
    const filter: Record<string, any> = {};
    if (query.scope) filter.scope = query.scope;
    if (query.storeId) filter.storeId = query.storeId;
    if (query.sellerId) filter.sellerId = query.sellerId;
    if (query.toolType) filter.toolType = query.toolType;
    if (query.status) filter.status = query.status;

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

    const [items, total] = await Promise.all([
      this.generationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.generationModel.countDocuments(filter),
    ]);

    const storeIds = [...new Set((items as any[]).map((i) => i.storeId).filter(Boolean))];
    const stores = storeIds.length
      ? await this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean()
      : [];
    const storeById = new Map(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: {
        items: (items as any[]).map((i) => ({
          ...i,
          storeName: i.storeId ? (storeById.get(i.storeId)?.name ?? null) : null,
          storeSlug: i.storeId ? (storeById.get(i.storeId)?.slug ?? null) : null,
        })),
        total, page, limit,
      },
    };
  }

  async getGeneration(generationId: string) {
    const generation = await this.generationModel.findById(generationId).lean();
    if (!generation) throw new NotFoundException('Generation not found');
    return { success: true, data: generation };
  }

  async listWallets(query: { page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

    const [wallets, total] = await Promise.all([
      this.walletModel.find({}).sort({ balance: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.walletModel.countDocuments({}),
    ]);

    const storeIds = (wallets as any[]).map((w) => w.storeId);
    const stores = storeIds.length
      ? await this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean()
      : [];
    const storeById = new Map(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: {
        items: (wallets as any[]).map((w) => ({
          _id: w._id, storeId: w.storeId, sellerId: w.sellerId,
          storeName: storeById.get(w.storeId)?.name ?? null,
          storeSlug: storeById.get(w.storeId)?.slug ?? null,
          balance: w.balance, monthlyAllowance: w.monthlyAllowance, lastResetAt: w.lastResetAt,
        })),
        total, page, limit,
      },
    };
  }

  async getWalletLedger(storeId: string) {
    const wallet = await this.walletModel.findOne({ storeId }).lean();
    if (!wallet) throw new NotFoundException('No AI credits wallet exists for this store yet.');
    return {
      success: true,
      data: {
        storeId, balance: (wallet as any).balance, monthlyAllowance: (wallet as any).monthlyAllowance,
        ledger: [...((wallet as any).ledger ?? [])].reverse(),
      },
    };
  }

  async adjustWallet(storeId: string, dto: AdjustWalletDto, admin: { id: string; name?: string; role?: string }) {
    const wallet = await this.walletModel.findOne({ storeId });
    if (!wallet) throw new NotFoundException('No AI credits wallet exists for this store yet.');

    const reason = `Admin adjustment (${admin.name ?? admin.id}): ${dto.reason}`;
    if (dto.direction === 'grant') {
      await this.aiCredits.grant(storeId, wallet.sellerId, dto.amount, reason);
    } else {
      await this.aiCredits.deduct(storeId, wallet.sellerId, dto.amount, reason);
    }

    await this.activityLog.log({
      storeId, category: 'ai_studio', action: 'admin_wallet_adjusted',
      description: `Admin ${dto.direction === 'grant' ? 'granted' : 'deducted'} ${dto.amount} AI credits — ${dto.reason}`,
      actorId: admin.id, actorName: admin.name ?? null, actorRole: admin.role ?? null,
      targetId: storeId, targetType: 'ai_credits_wallet',
    });

    const updated = await this.walletModel.findOne({ storeId }).lean();
    return {
      success: true,
      data: { storeId, balance: (updated as any)?.balance ?? 0, monthlyAllowance: (updated as any)?.monthlyAllowance ?? 0 },
    };
  }

  async listTransactions(query: {
    storeId?: string; toolUsed?: AiToolType; status?: string; page?: number; limit?: number;
  }) {
    const filter: Record<string, any> = {};
    if (query.storeId) filter.storeId = query.storeId;
    if (query.toolUsed) filter.toolUsed = query.toolUsed;
    if (query.status) filter.status = query.status;

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

    const [items, total] = await Promise.all([
      this.txnModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.txnModel.countDocuments(filter),
    ]);
    return { success: true, data: { items, total, page, limit } };
  }

  // ======================================================= PLATFORM GENERATE

  async generatePlatformSeo(adminId: string, dto: AdminGenerateSeoDto) {
    return this.runPlatformGeneration({
      adminId, tool: 'seo_booster', regenerateFromId: dto.regenerateFromId,
      inputPayload: { title: dto.title, currentTags: dto.currentTags ?? [] },
      execute: async () => {
        const lookup = await this.keywordData.lookupKeywords({ topic: dto.title, currentTags: dto.currentTags });
        const { system, prompt } = buildSeoWritingPrompt({
          title: dto.title, description: dto.description, currentTags: dto.currentTags ?? [], keywordSignals: lookup.keywords,
        });
        const result = await this.textGeneration.generate({ system, prompt, tier: 'standard', schema: SEO_WRITING_SCHEMA });

        const signalByKeyword = new Map(lookup.keywords.map((k) => [k.keyword.toLowerCase(), k]));
        const optimizedTags = (result.json!.optimizedTags as string[]).map((tag) => {
          const signal = signalByKeyword.get(String(tag).toLowerCase());
          return { tag: String(tag), isVerifiedData: signal ? signal.isVerifiedData : false, competition: signal?.competition ?? null };
        });

        return {
          output: {
            optimizedTitle: result.json!.optimizedTitle, optimizedTags,
            rankingNotes: result.json!.rankingNotes, lowConfidence: lookup.lowConfidence,
          },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  async generatePlatformEmail(adminId: string, dto: AdminGenerateEmailDto) {
    return this.runPlatformGeneration({
      adminId, tool: 'email_campaigns', regenerateFromId: dto.regenerateFromId,
      inputPayload: { campaignGoal: dto.campaignGoal, tone: dto.tone },
      execute: async () => {
        const { system, prompt } = buildEmailCampaignPrompt({
          campaignGoal: dto.campaignGoal, tone: dto.tone, storeName: 'Edudeen', products: [],
        });
        const result = await this.textGeneration.generate({ system, prompt, tier: 'standard', schema: EMAIL_CAMPAIGN_SCHEMA });
        return {
          output: { subject: result.json!.subject, previewText: result.json!.previewText, body: result.json!.body },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  async startPlatformImageEnhance(adminId: string, dto: AdminGenerateImageEnhanceDto) {
    const generation = await this.createPlatformGeneration({
      adminId, tool: 'image_enhancer', regenerateFromId: dto.regenerateFromId,
      inputPayload: { imageUrl: dto.imageUrl, enhancementType: dto.enhancementType },
    });
    void this.processPlatformImageJob(generation._id.toString(), dto);
    return {
      success: true,
      message: 'Enhancement started — poll the job for the result.',
      data: { jobId: generation._id.toString(), status: 'processing' as const, creditsCharged: 0 },
    };
  }

  private async processPlatformImageJob(generationId: string, dto: AdminGenerateImageEnhanceDto) {
    try {
      const result = await this.imageEnhance.enhance({ imageUrl: dto.imageUrl, enhancementType: dto.enhancementType });
      await this.generationModel.updateOne(
        { _id: generationId },
        {
          $set: {
            status: 'succeeded',
            outputPayload: { enhancedImageUrl: result.enhancedImageUrl, originalImageUrl: result.originalImageUrl, note: result.note ?? null },
            providerUsed: result.provider, creditsCharged: 0,
          },
        },
      );
    } catch (error) {
      const message = error instanceof AiProviderError ? error.message : 'Image enhancement failed unexpectedly.';
      this.logger.error(`Platform image job ${generationId} failed: ${(error as Error).message}`);
      await this.generationModel.updateOne({ _id: generationId }, { $set: { status: 'failed', errorMessage: message, creditsCharged: 0 } });
    }
  }

  async getPlatformImageJob(jobId: string) {
    const job = await this.generationModel.findOne({ _id: jobId, scope: 'platform', toolType: 'image_enhancer' }).lean();
    if (!job) throw new NotFoundException('Enhancement job not found');
    return {
      success: true,
      data: {
        jobId, status: (job as any).status, errorMessage: (job as any).errorMessage,
        ...((job as any).outputPayload ?? {}),
      },
    };
  }

  // -------------------------------------------------------------- internals

  private async createPlatformGeneration(params: {
    adminId: string; tool: AiToolType; regenerateFromId?: string; inputPayload: Record<string, any>;
  }) {
    let sessionId = new Types.ObjectId().toString();
    let regeneratedFromId: string | null = null;
    if (params.regenerateFromId) {
      const parent = await this.generationModel.findOne({ _id: params.regenerateFromId, scope: 'platform', toolType: params.tool }).lean();
      if (!parent) throw new NotFoundException('Generation to regenerate from was not found');
      sessionId = (parent as any).sessionId;
      regeneratedFromId = params.regenerateFromId;
    }

    return this.generationModel.create({
      scope: 'platform', adminId: params.adminId, sellerId: null, storeId: null,
      toolType: params.tool, status: 'processing', inputPayload: params.inputPayload,
      sessionId, regeneratedFromId,
    });
  }

  /** Same success/failure lifecycle as the seller side's `runGeneration`, minus any wallet hold/capture/refund — Edudeen's own usage is never charged. */
  private async runPlatformGeneration(params: {
    adminId: string; tool: AiToolType; regenerateFromId?: string; inputPayload: Record<string, any>;
    execute: () => Promise<{ output: Record<string, any>; provider: string; model: string }>;
  }) {
    const generation = await this.createPlatformGeneration(params);
    const generationId = generation._id.toString();

    try {
      const { output, provider, model } = await params.execute();
      await this.generationModel.updateOne(
        { _id: generationId },
        { $set: { status: 'succeeded', outputPayload: output, providerUsed: provider, modelUsed: model, creditsCharged: 0 } },
      );
      return {
        success: true,
        data: { generationId, sessionId: generation.sessionId, creditsCharged: 0, provider, ...output },
      };
    } catch (error) {
      const providerError = error instanceof AiProviderError ? error : null;
      const message = providerError?.message ?? (error as Error).message ?? 'Generation failed';
      this.logger.error(`Platform ${params.tool} generation ${generationId} failed: ${message}`);
      await this.generationModel.updateOne({ _id: generationId }, { $set: { status: 'failed', errorMessage: message, creditsCharged: 0 } });
      throw error;
    }
  }
}
