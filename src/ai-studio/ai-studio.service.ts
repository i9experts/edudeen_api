/* eslint-disable prettier/prettier */
import { cleanAiText, cleanAiTags } from './ai-output.util';
import {
  BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { AiStudioCreditsService } from './ai-studio-credits.service';
import { AiProviderError } from './providers/ai-provider.interfaces';
import { TextGenerationService } from './providers/text-generation.service';
import { KeywordDataService } from './providers/keyword-data.service';
import { PricingDataService } from './providers/pricing-data.service';
import { ImageEnhanceService } from './providers/image-enhance.service';
import { AiToolType } from './schemas/ai-generation.schema';
import {
  AcceptGenerationDto, GenerateEmailDto, GenerateImageEnhanceDto, GenerateListingDto,
  GeneratePriceDto, GenerateSeoDto, GenerateWorksheetDto, GenerateWorksheetTrialDto,
} from './dto/generate.dto';
import {
  EMAIL_CAMPAIGN_SCHEMA, LISTING_WRITER_SCHEMA, PRICE_EXPLANATION_SCHEMA, SEO_WRITING_SCHEMA,
  WORKSHEET_SCHEMA, buildEmailCampaignPrompt, buildListingWriterPrompt, buildPriceExplanationPrompt,
  buildSeoWritingPrompt, buildWorksheetPrompt,
} from './tools/tool-definitions';

/** Frontend-mappable error codes for generation failures. */
export const AI_PROVIDER_UNAVAILABLE = 'AI_PROVIDER_UNAVAILABLE'; // retryable — show "try again"
export const AI_GENERATION_REJECTED = 'AI_GENERATION_REJECTED';   // not retryable as-is — change the input

@Injectable()
export class AiStudioService {
  private readonly logger = new Logger(AiStudioService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly credits: AiStudioCreditsService,
    private readonly textGeneration: TextGenerationService,
    private readonly keywordData: KeywordDataService,
    private readonly pricingData: PricingDataService,
    private readonly imageEnhance: ImageEnhanceService,
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  private get generationModel() { return this.db.repositories.aiGenerationModel; }

  /** Balance + usage for the "N credits remaining" UI (ownership-checked). */
  async getCredits(sellerId: string, storeId: string) {
    await this.verifyStore(storeId, sellerId);
    return this.credits.getCreditsOverview(storeId, sellerId);
  }

  // ---------------------------------------------------------------- tools

  async generateListing(sellerId: string, storeId: string, dto: GenerateListingDto) {
    await this.verifyStore(storeId, sellerId);
    const keywords = (Array.isArray(dto.keywords) ? dto.keywords : [dto.keywords])
      .map((k) => String(k).trim()).filter(Boolean);
    if (keywords.length === 0) throw new BadRequestException('keywords must contain at least one non-empty value');

    if (dto.productId) await this.getOwnedProduct(storeId, dto.productId);

    return this.runGeneration({
      sellerId, storeId, tool: 'listing_writer', productId: dto.productId ?? null,
      regenerateFromId: dto.regenerateFromId,
      inputPayload: { productType: dto.productType, keywords, tone: dto.tone },
      execute: async () => {
        const { system, prompt } = buildListingWriterPrompt({ productType: dto.productType, keywords, tone: dto.tone });
        const result = await this.textGeneration.generate({ system, prompt, tier: 'standard', schema: LISTING_WRITER_SCHEMA });
        return {
          output: {
            title: result.json!.title,
            description: result.json!.description,
            suggestedTags: result.json!.suggestedTags,
          },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  async generateSeo(sellerId: string, storeId: string, dto: GenerateSeoDto) {
    await this.verifyStore(storeId, sellerId);

    let title = dto.title ?? '';
    let description = dto.description ?? '';
    let currentTags = dto.currentTags ?? [];
    let categoryName: string | undefined;

    if (dto.productId) {
      const product = await this.getOwnedProduct(storeId, dto.productId);
      title = dto.title ?? product.name;
      description = dto.description ?? product.description ?? '';
      if (!dto.currentTags) currentTags = product.tags ?? [];
      categoryName = await this.getCategoryName(product.categoryId);
    }
    if (!title) throw new BadRequestException('Provide a productId or a title to optimize');

    return this.runGeneration({
      sellerId, storeId, tool: 'seo_booster', productId: dto.productId ?? null,
      regenerateFromId: dto.regenerateFromId,
      inputPayload: { productId: dto.productId ?? null, title, currentTags },
      execute: async () => {
        // Step 1 — real-world keyword signals (Claude + web search; degrades gracefully).
        const lookup = await this.keywordData.lookupKeywords({ topic: title, categoryName, currentTags });

        // Step 2 — writing pass on the cost-efficient standard model.
        const { system, prompt } = buildSeoWritingPrompt({ title, description, currentTags, keywordSignals: lookup.keywords });
        const result = await this.textGeneration.generate({ system, prompt, tier: 'standard', schema: SEO_WRITING_SCHEMA });

        const signalByKeyword = new Map(lookup.keywords.map((k) => [k.keyword.toLowerCase(), k]));
        const optimizedTags = (result.json!.optimizedTags as string[]).map((tag) => {
          const signal = signalByKeyword.get(String(tag).toLowerCase());
          return {
            tag: String(tag),
            // Honest confidence labeling: true only when a dedicated keyword-metrics
            // API backs the signal — the current web-search implementation never is.
            isVerifiedData: signal ? signal.isVerifiedData : false,
            competition: signal?.competition ?? null,
          };
        });

        return {
          output: {
            optimizedTitle: result.json!.optimizedTitle,
            optimizedTags,
            rankingNotes: result.json!.rankingNotes,
            lowConfidence: lookup.lowConfidence,
            keywordResearch: lookup.keywords,
          },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  async generateEmail(sellerId: string, storeId: string, dto: GenerateEmailDto) {
    const store = await this.verifyStore(storeId, sellerId);
    await this.entitlements?.assertFeatureAllowed(storeId, 'emailCampaignsAllowed', 'Email campaigns');

    const products: Array<{ name: string; price?: number | null }> = [];
    for (const productId of dto.productIds ?? []) {
      const product = await this.getOwnedProduct(storeId, productId);
      const variant = await this.db.repositories.productVariantModel
        .findOne({ productId: product._id.toString() }).sort({ price: 1 }).lean();
      products.push({ name: product.name, price: (variant as any)?.price ?? null });
    }

    return this.runGeneration({
      sellerId, storeId, tool: 'email_campaigns', productId: null,
      regenerateFromId: dto.regenerateFromId,
      inputPayload: { campaignGoal: dto.campaignGoal, tone: dto.tone, productIds: dto.productIds ?? [] },
      execute: async () => {
        const { system, prompt } = buildEmailCampaignPrompt({
          campaignGoal: dto.campaignGoal, tone: dto.tone, storeName: (store).name, products,
        });
        const result = await this.textGeneration.generate({ system, prompt, tier: 'standard', schema: EMAIL_CAMPAIGN_SCHEMA });
        return {
          output: {
            subject: result.json!.subject,
            previewText: result.json!.previewText,
            body: result.json!.body,
          },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  async generateWorksheet(sellerId: string, storeId: string, dto: GenerateWorksheetDto) {
    await this.verifyStore(storeId, sellerId);

    return this.runGeneration({
      sellerId, storeId, tool: 'worksheet_builder', productId: null,
      regenerateFromId: dto.regenerateFromId,
      inputPayload: {
        subject: dto.subject, gradeLevel: dto.gradeLevel, topics: dto.topics,
        questionCount: dto.questionCount, includeAnswerKey: dto.includeAnswerKey,
      },
      execute: async () => {
        const { system, prompt } = buildWorksheetPrompt(dto);
        // Structured JSON only — a separate (non-AI) renderer produces the
        // downloadable worksheet file from this payload.
        const result = await this.textGeneration.generate({
          system, prompt, tier: 'advanced', schema: WORKSHEET_SCHEMA, maxTokens: 8000,
        });
        return {
          output: { title: result.json!.title, sections: result.json!.sections },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  /** Public "Try free" version of the worksheet builder — no store/seller, no
   *  credit wallet, no generation history. Cost is bounded entirely by the
   *  DTO's own caps (max 6 questions) plus the controller's rate limit. */
  async generateWorksheetTrial(dto: GenerateWorksheetTrialDto) {
    try {
      const { system, prompt } = buildWorksheetPrompt(dto);
      const result = await this.textGeneration.generate({
        system, prompt, tier: 'standard', schema: WORKSHEET_SCHEMA, maxTokens: 2000,
      });
      return {
        success: true,
        data: { title: result.json!.title, sections: result.json!.sections, provider: result.provider },
      };
    } catch (error) {
      const providerError = error instanceof AiProviderError ? error : null;
      const message = providerError?.message ?? 'Generation failed unexpectedly.';
      this.logger.error(`worksheet_builder trial failed: ${message}`);
      throw new HttpException({
        success: false,
        errorCode: providerError?.retryable ?? true ? AI_PROVIDER_UNAVAILABLE : AI_GENERATION_REJECTED,
        message,
      }, providerError?.retryable ?? true ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  async generatePrice(sellerId: string, storeId: string, dto: GeneratePriceDto) {
    await this.verifyStore(storeId, sellerId);

    let categoryId = dto.categoryId ?? '';
    let productType: string | undefined;
    let productName = dto.attributes || 'this product';
    let excludeProductId: string | undefined;

    if (dto.productId) {
      const product = await this.getOwnedProduct(storeId, dto.productId);
      categoryId = product.categoryId;
      productType = product.productType;
      productName = product.name;
      excludeProductId = product._id.toString();
    }
    if (!categoryId) throw new BadRequestException('Provide a productId or a categoryId');
    const categoryName = await this.getCategoryName(categoryId);

    // PRIMARY source: statistical range from our own comparable listings.
    const stats = await this.pricingData.getComparableStats({ categoryId, productType, excludeProductId });

    // No comparables at all (brand-new category): return an honest low-confidence
    // result with NO fabricated numbers and NO credit charge.
    if (stats.sampleSize === 0) {
      const generation = await this.createGeneration({
        sellerId, storeId, tool: 'price_optimizer', productId: dto.productId ?? null,
        regenerateFromId: dto.regenerateFromId,
        inputPayload: { productId: dto.productId ?? null, categoryId, attributes: dto.attributes ?? null },
      });
      const output = {
        suggestedPrice: null, suggestedPriceMin: null, suggestedPriceMax: null,
        comparableListingsSampleSize: 0, lowConfidence: true, externalMarketNote: null,
        explanation: 'There are no comparable active listings in this category yet, so a data-backed price suggestion is not possible. No credits were charged. Try again once similar products are listed, or set an introductory price and adjust from early sales.',
      };
      await this.generationModel.updateOne(
        { _id: generation._id },
        { $set: { status: 'succeeded', outputPayload: output, creditsCharged: 0, providerUsed: 'database' } },
      );
      return { success: true, data: { generationId: generation._id.toString(), sessionId: generation.sessionId, creditsCharged: 0, ...output } };
    }

    const suggested = stats.medianPrice!;
    const suggestedMin = stats.p25Price!;
    const suggestedMax = stats.p75Price!;

    return this.runGeneration({
      sellerId, storeId, tool: 'price_optimizer', productId: dto.productId ?? null,
      regenerateFromId: dto.regenerateFromId,
      inputPayload: { productId: dto.productId ?? null, categoryId, attributes: dto.attributes ?? null },
      execute: async () => {
        // Claude narrates the COMPUTED numbers only — it is not their source.
        const { system, prompt } = buildPriceExplanationPrompt({
          productName, categoryName, sampleSize: stats.sampleSize,
          suggestedPrice: suggested, suggestedPriceMin: suggestedMin, suggestedPriceMax: suggestedMax,
          medianPrice: stats.medianPrice!,
        });
        const result = await this.textGeneration.generate({ system, prompt, tier: 'standard', schema: PRICE_EXPLANATION_SCHEMA, maxTokens: 1024 });

        // SECONDARY, clearly-labeled web signal — never blended into the numbers.
        const externalMarketNote = await this.pricingData.getExternalMarketNote({ productName, categoryName });

        return {
          output: {
            suggestedPrice: suggested,
            suggestedPriceMin: suggestedMin,
            suggestedPriceMax: suggestedMax,
            comparableListingsSampleSize: stats.sampleSize,
            lowConfidence: stats.lowConfidence,
            explanation: result.json!.explanation,
            externalMarketNote,
          },
          provider: result.provider, model: result.model,
        };
      },
    });
  }

  /**
   * Image Enhancer — async by design: returns a jobId immediately, the client
   * polls getImageJob until status leaves 'processing'. The adapter is a stub
   * today; the credits/history/job plumbing is fully wired so a real provider
   * is a one-file swap (see providers/image-enhance.service.ts).
   */
  async startImageEnhance(sellerId: string, storeId: string, dto: GenerateImageEnhanceDto) {
    await this.verifyStore(storeId, sellerId);

    const generation = await this.createGeneration({
      sellerId, storeId, tool: 'image_enhancer', productId: null,
      regenerateFromId: dto.regenerateFromId,
      inputPayload: { imageUrl: dto.imageUrl, enhancementType: dto.enhancementType },
    });

    const txnId = await this.holdOrFailGeneration(generation._id.toString(), storeId, sellerId, 'image_enhancer');

    // Fire-and-forget background processing — errors are captured on the job record.
    void this.processImageJob(generation._id.toString(), txnId, dto);

    return {
      success: true,
      message: 'Enhancement started — poll the job for the result.',
      data: {
        jobId: generation._id.toString(),
        status: 'processing',
        creditsCharged: this.credits.costOf('image_enhancer'),
        pollUrl: `api/ai-studio/${storeId}/image-enhancer/jobs/${generation._id.toString()}`,
      },
    };
  }

  private async processImageJob(generationId: string, txnId: string, dto: GenerateImageEnhanceDto) {
    try {
      const result = await this.imageEnhance.enhance({ imageUrl: dto.imageUrl, enhancementType: dto.enhancementType });
      await this.credits.capture(txnId);
      await this.generationModel.updateOne(
        { _id: generationId },
        {
          $set: {
            status: 'succeeded',
            outputPayload: {
              enhancedImageUrl: result.enhancedImageUrl,
              originalImageUrl: result.originalImageUrl,
              note: result.note ?? null,
            },
            providerUsed: result.provider,
            creditsCharged: this.credits.costOf('image_enhancer'),
          },
        },
      );
    } catch (error) {
      const message = error instanceof AiProviderError ? error.message : 'Image enhancement failed unexpectedly.';
      this.logger.error(`Image job ${generationId} failed: ${(error as Error).message}`);
      await this.credits.refund(txnId, `image_enhancer failed: ${message}`);
      await this.generationModel.updateOne(
        { _id: generationId },
        { $set: { status: 'failed', errorMessage: message, creditsCharged: 0 } },
      );
    }
  }

  async getImageJob(sellerId: string, storeId: string, jobId: string) {
    await this.verifyStore(storeId, sellerId);
    const job = await this.generationModel
      .findOne({ _id: jobId, storeId, toolType: 'image_enhancer' }).lean();
    if (!job) throw new NotFoundException('Enhancement job not found');
    return {
      success: true,
      data: {
        jobId,
        status: (job as any).status,
        creditsCharged: (job as any).creditsCharged,
        errorMessage: (job as any).errorMessage,
        ...(job as any).outputPayload ?? {},
      },
    };
  }

  // ------------------------------------------------------ history / accept

  async listGenerations(sellerId: string, storeId: string, query: { toolType?: string; sessionId?: string; page?: string; limit?: string }) {
    await this.verifyStore(storeId, sellerId);
    const filter: Record<string, any> = { storeId };
    if (query.toolType) filter.toolType = query.toolType;
    if (query.sessionId) filter.sessionId = query.sessionId;

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? '20', 10) || 20));

    const [items, total] = await Promise.all([
      this.generationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.generationModel.countDocuments(filter),
    ]);
    return { success: true, data: { items, total, page, limit } };
  }

  async getGeneration(sellerId: string, storeId: string, generationId: string) {
    await this.verifyStore(storeId, sellerId);
    const generation = await this.generationModel.findOne({ _id: generationId, storeId }).lean();
    if (!generation) throw new NotFoundException('Generation not found');
    return { success: true, data: generation };
  }

  /**
   * "Use This" — mark the generation accepted and (optionally) write its
   * output into the actual product record.
   */
  async acceptGeneration(sellerId: string, storeId: string, generationId: string, dto: AcceptGenerationDto) {
    await this.verifyStore(storeId, sellerId);
    const generation = await this.generationModel.findOne({ _id: generationId, storeId });
    if (!generation) throw new NotFoundException('Generation not found');
    if (generation.status !== 'succeeded') throw new BadRequestException('Only a succeeded generation can be accepted');

    let appliedToProduct = false;
    if (dto.applyToProduct) {
      const productId = dto.productId ?? generation.productId;
      if (!productId) throw new BadRequestException('No productId on this generation — pass one to apply the output');
      const product = await this.getOwnedProduct(storeId, productId);
      const update = this.buildProductUpdate(generation.toolType, generation.outputPayload ?? {});
      if (!update) throw new BadRequestException(`Output of ${generation.toolType} cannot be applied to a product`);
      await this.db.repositories.productModel.updateOne({ _id: product._id }, { $set: update });
      appliedToProduct = true;
      generation.productId = productId;
    }

    generation.accepted = true;
    generation.acceptedAt = new Date();
    generation.appliedToProduct = generation.appliedToProduct || appliedToProduct;
    await generation.save();

    return { success: true, message: appliedToProduct ? 'Output applied to the product' : 'Generation marked as accepted', data: generation };
  }

  private buildProductUpdate(toolType: AiToolType, output: Record<string, any>): Record<string, any> | null {
    // Everything is reduced to plain bounded text (see ai-output.util) before it touches a public product field.
    if (toolType === 'listing_writer') {
      const name = cleanAiText(output.title, 200);
      const description = cleanAiText(output.description, 5000);
      const tags = cleanAiTags(output.suggestedTags);
      return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(tags ? { tags } : {}) };
    }
    if (toolType === 'seo_booster') {
      const name = cleanAiText(output.optimizedTitle, 200);
      const tags = cleanAiTags(output.optimizedTags);
      return { ...(name ? { name } : {}), ...(tags ? { tags } : {}) };
    }
    return null;
  }

  // ------------------------------------------------------------- internals

  private async verifyStore(storeId: string, sellerId: string) {
    return verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
  }

  private async getOwnedProduct(storeId: string, productId: string) {
    const product = await this.db.repositories.productModel
      .findOne({ _id: productId, storeId, isDelete: false });
    if (!product) throw new NotFoundException('Product not found in this store');
    return product;
  }

  private async getCategoryName(categoryId: string): Promise<string | undefined> {
    if (!categoryId || !Types.ObjectId.isValid(categoryId)) return undefined;
    const category = await this.db.repositories.categoryModel.findById(categoryId).select('name').lean();
    return (category as any)?.name;
  }

  private async createGeneration(params: {
    sellerId: string; storeId: string; tool: AiToolType; productId: string | null;
    regenerateFromId?: string; inputPayload: Record<string, any>;
  }) {
    // Regenerate = new row in the SAME session, never an overwrite.
    let sessionId = new Types.ObjectId().toString();
    let regeneratedFromId: string | null = null;
    if (params.regenerateFromId) {
      const parent = await this.generationModel
        .findOne({ _id: params.regenerateFromId, storeId: params.storeId, toolType: params.tool }).lean();
      if (!parent) throw new NotFoundException('Generation to regenerate from was not found');
      sessionId = (parent as any).sessionId;
      regeneratedFromId = params.regenerateFromId;
    }

    return this.generationModel.create({
      sellerId: params.sellerId, storeId: params.storeId, toolType: params.tool,
      status: 'processing', inputPayload: params.inputPayload,
      sessionId, regeneratedFromId, productId: params.productId,
    });
  }

  private async holdOrFailGeneration(generationId: string, storeId: string, sellerId: string, tool: AiToolType): Promise<string> {
    try {
      return await this.credits.hold(storeId, sellerId, tool, generationId);
    } catch (error) {
      await this.generationModel.updateOne(
        { _id: generationId },
        { $set: { status: 'failed', errorMessage: 'Insufficient AI credits' } },
      );
      throw error;
    }
  }

  /**
   * Shared lifecycle for the synchronous (text) tools:
   * create history row → hold credits → provider call → capture on success /
   * auto-refund on failure. A failed generation is never charged.
   */
  private async runGeneration(params: {
    sellerId: string; storeId: string; tool: AiToolType; productId: string | null;
    regenerateFromId?: string; inputPayload: Record<string, any>;
    execute: () => Promise<{ output: Record<string, any>; provider: string; model: string }>;
  }) {
    const generation = await this.createGeneration(params);
    const generationId = generation._id.toString();
    const txnId = await this.holdOrFailGeneration(generationId, params.storeId, params.sellerId, params.tool);
    const cost = this.credits.costOf(params.tool);

    try {
      const { output, provider, model } = await params.execute();
      await this.credits.capture(txnId);
      await this.generationModel.updateOne(
        { _id: generationId },
        { $set: { status: 'succeeded', outputPayload: output, providerUsed: provider, modelUsed: model, creditsCharged: cost } },
      );
      return {
        success: true,
        data: { generationId, sessionId: generation.sessionId, creditsCharged: cost, provider, ...output },
      };
    } catch (error) {
      const providerError = error instanceof AiProviderError ? error : null;
      const message = providerError?.message ?? (error as Error).message ?? 'Generation failed';
      this.logger.error(`${params.tool} generation ${generationId} failed (provider: ${this.textGeneration.providerName}): ${message}`);

      await this.credits.refund(txnId, `${params.tool} failed: ${message}`);
      await this.generationModel.updateOne(
        { _id: generationId },
        { $set: { status: 'failed', errorMessage: message, creditsCharged: 0 } },
      );

      if (providerError) {
        throw new HttpException({
          success: false,
          errorCode: providerError.retryable ? AI_PROVIDER_UNAVAILABLE : AI_GENERATION_REJECTED,
          message: `${message} Your credits were not charged.`,
          data: { retryable: providerError.retryable, generationId },
        }, providerError.retryable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (error instanceof HttpException) throw error;
      throw new HttpException({
        success: false, errorCode: AI_PROVIDER_UNAVAILABLE,
        message: 'Generation failed unexpectedly. Your credits were not charged.',
        data: { retryable: true, generationId },
      }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
