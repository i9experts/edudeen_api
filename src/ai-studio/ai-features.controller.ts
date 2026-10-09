/* eslint-disable prettier/prettier */
import {
  Body, Controller, Get, HttpException, HttpStatus, Param, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { AI_FEATURE_DEFS, AI_FEATURE_KEYS, AiFeatureKey, isAiFeatureKey } from './core/ai-features';
import { AiFlagsService } from './core/ai-flags.service';
import { AiService } from './core/ai.service';
import { TextGenerationService } from './providers/text-generation.service';
import { SmartSearchService } from './features/smart-search.service';
import { AssistantService } from './features/assistant.service';
import { ReviewsAiService } from './features/reviews-ai.service';
import { TranslateService, TranslateDirection } from './features/translate.service';
import { CodRiskService } from './features/cod-risk.service';
import { InsightsService } from './features/insights.service';
import { HelpBotService } from './features/help-bot.service';
import { StudioExtrasService } from './features/studio-extras.service';
import { ModerationAiService } from './features/moderation-ai.service';
import { AskDataService } from './features/ask-data.service';

class FlagDto {
  @IsString() @MaxLength(40) feature: string;
  @IsBoolean() enabled: boolean;
}
class StoreOverrideDto {
  @IsMongoId() storeId: string;
  @IsString() @MaxLength(40) feature: string;
  @IsBoolean() enabled: boolean;
}
class TranslateDto {
  @IsString() @MaxLength(300) title: string;
  @IsOptional() @IsString() @MaxLength(6000) description?: string;
  @IsOptional() @IsIn(['en_to_ur', 'ur_to_en']) direction?: TranslateDirection;
}
class UrduCopyDto {
  @IsOptional() @IsString() @MaxLength(300) nameUr?: string;
  @IsOptional() @IsString() @MaxLength(6000) descriptionUr?: string;
}
class QuestionDto { @IsString() @MaxLength(500) question: string; }
class ImageCheckDto {
  @IsString() @MaxLength(1000) imageUrl: string;
  @IsOptional() @IsString() @MaxLength(200) productName?: string;
}
class ReplyDraftDto { @IsOptional() @IsIn(['friendly', 'professional']) tone?: 'friendly' | 'professional'; }

/** Public / buyer-facing AI endpoints. Everything degrades to "available:false" when AI is off. */
@ApiTags('AI')
@Controller('api/ai')
export class AiPublicController {
  constructor(
    private readonly ai: AiService, private readonly flags: AiFlagsService, private readonly textGen: TextGenerationService,
    private readonly search: SmartSearchService, private readonly assistant: AssistantService, private readonly reviews: ReviewsAiService,
  ) {}

  /** The web app hides AI UI unless `available && features[x]`. */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('features')
  async features(@Query('storeId') storeId?: string) {
    const features = await this.flags.enabledMap(storeId && /^[a-f0-9]{24}$/i.test(storeId) ? storeId : null);
    return { success: true, data: { available: this.ai.isAvailable(), studio: this.textGen.available, features } };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  smartSearch(@Req() req: any, @Query('q') q: string) {
    return this.search.search(typeof q === 'string' ? q : '', req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('assistant/chat')
  chat(@Req() req: any, @Body() body: { messages?: unknown }) {
    const buyerId = req.user?.role === 'user' ? req.user.userId : null;
    return this.assistant.chat(buyerId, body?.messages);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('reviews/summary/:productId')
  reviewSummary(@Param('productId', ParseObjectIdPipe) productId: string) {
    return this.reviews.summary(productId);
  }

  /** TODO(owner): voice search needs a speech-to-text provider (Whisper/Google STT). The browser can use the Web Speech API and call GET /api/ai/search with the transcript. */
  @Post('voice-search')
  voiceSearch() {
    throw new HttpException({ success: false, errorCode: 'NOT_IMPLEMENTED', message: 'Voice search is coming soon. Type your search for now.' }, HttpStatus.NOT_IMPLEMENTED);
  }

  /** TODO(owner): quiz generation + audio (text-to-speech) need a TTS provider and a quiz data model. */
  @Post('quiz-audio')
  quizAudio() {
    throw new HttpException({ success: false, errorCode: 'NOT_IMPLEMENTED', message: 'Quizzes and audio are coming soon.' }, HttpStatus.NOT_IMPLEMENTED);
  }
}

@ApiTags('AI (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('api/ai/seller/:storeId')
export class AiSellerController {
  constructor(
    private readonly translate: TranslateService, private readonly cod: CodRiskService, private readonly reviews: ReviewsAiService,
    private readonly insights: InsightsService, private readonly help: HelpBotService, private readonly extras: StudioExtrasService,
  ) {}

  @Post('translate')
  translateText(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: TranslateDto) {
    return this.translate.translateText(req.user.userId, storeId, dto);
  }

  @Post('translate/batch')
  translateBatch(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.translate.translateBatch(req.user.userId, storeId);
  }

  @Post('products/:productId/translate')
  translateProduct(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('productId', ParseObjectIdPipe) productId: string) {
    return this.translate.translateProduct(req.user.userId, storeId, productId);
  }

  @Put('products/:productId/urdu')
  saveUrdu(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('productId', ParseObjectIdPipe) productId: string, @Body() dto: UrduCopyDto) {
    return this.translate.saveUrdu(req.user.userId, storeId, productId, dto);
  }

  @Get('orders/:orderId/cod-risk')
  codRisk(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('orderId', ParseObjectIdPipe) orderId: string, @Query('explain') explain?: string) {
    return this.cod.forOrder(req.user.userId, storeId, orderId, explain !== '0');
  }

  @Post('reviews/:ratingId/reply-draft')
  replyDraft(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('ratingId', ParseObjectIdPipe) ratingId: string, @Body() dto: ReplyDraftDto) {
    return this.reviews.replyDraft(req.user.userId, storeId, ratingId, dto?.tone);
  }

  @Post('insights/weekly')
  weekly(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.insights.generate(req.user.userId, storeId);
  }

  @Get('insights/latest')
  latestInsights(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.insights.latest(req.user.userId, storeId);
  }

  @Post('help')
  helpBot(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: QuestionDto) {
    return this.help.ask(req.user.userId, storeId, dto.question);
  }

  @Post('products/:productId/cover')
  cover(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('productId', ParseObjectIdPipe) productId: string) {
    return this.extras.coverFor(req.user.userId, storeId, productId);
  }

  @Post('image-check')
  imageCheck(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: ImageCheckDto) {
    return this.extras.imageCheck(req.user.userId, storeId, dto.imageUrl, dto.productName);
  }

  @Get('worksheets/:generationId/html')
  worksheetHtml(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('generationId', ParseObjectIdPipe) generationId: string, @Query('answers') answers?: string) {
    return this.extras.worksheetHtml(req.user.userId, storeId, generationId, answers === '1');
  }
}

@ApiTags('AI (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/ai')
export class AiAdminController {
  constructor(
    private readonly ai: AiService, private readonly flags: AiFlagsService, private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService, private readonly moderation: ModerationAiService, private readonly askData: AskDataService,
  ) {}

  private async audit(req: any, action: string, description: string) {
    await this.activityLog.log({
      storeId: null as any, category: 'ai_studio', action, description,
      actorId: req.user.userId, actorName: null, actorRole: 'admin', targetId: null as any, targetType: 'ai_config',
    } as any).catch(() => undefined);
  }

  @Get('config')
  async config() {
    const raw = await this.flags.rawConfig();
    return {
      success: true,
      data: {
        available: this.ai.isAvailable(), modelStandard: this.ai.modelStandard, modelFast: this.ai.modelFast,
        features: AI_FEATURE_KEYS.map((key) => ({ key, ...AI_FEATURE_DEFS[key], enabled: raw.featureFlags[key] !== false })),
        allEnabled: raw.featureFlags.__all !== false,
        storeOverrides: raw.storeOverrides,
      },
    };
  }

  /** Global kill switch: `feature` is a feature key or `__all`. */
  @Put('flags')
  async setFlag(@Req() req: any, @Body() dto: FlagDto) {
    if (dto.feature !== '__all' && !isAiFeatureKey(dto.feature)) throw new HttpException({ success: false, message: 'Unknown AI feature' }, HttpStatus.BAD_REQUEST);
    await this.db.repositories.platformConfigModel.findOneAndUpdate({}, { $set: { [`aiConfig.featureFlags.${dto.feature}`]: dto.enabled } }, { upsert: true, setDefaultsOnInsert: true });
    this.flags.invalidate();
    await this.audit(req, 'ai_feature_toggled', `AI feature ${dto.feature} ${dto.enabled ? 'enabled' : 'disabled'} platform-wide`);
    return { success: true, message: 'Saved' };
  }

  /** Per-store kill switch. */
  @Put('store-overrides')
  async setStoreOverride(@Req() req: any, @Body() dto: StoreOverrideDto) {
    if (dto.feature !== '__all' && !isAiFeatureKey(dto.feature)) throw new HttpException({ success: false, message: 'Unknown AI feature' }, HttpStatus.BAD_REQUEST);
    const model = this.db.repositories.platformConfigModel;
    const path = `aiConfig.storeOverrides.${dto.storeId}`;
    await model.findOneAndUpdate({}, dto.enabled ? { $pull: { [path]: dto.feature } } : { $addToSet: { [path]: dto.feature } }, { upsert: true, setDefaultsOnInsert: true });
    this.flags.invalidate();
    await this.audit(req, 'ai_store_override', `AI feature ${dto.feature} ${dto.enabled ? 're-enabled' : 'disabled'} for store ${dto.storeId}`);
    return { success: true, message: 'Saved' };
  }

  /** Cost / latency per feature (from per-call logs). */
  @Get('usage')
  async usage(@Query('days') days?: string) {
    const d = Math.min(365, Math.max(1, Number(days) || 28));
    const rows = await this.db.repositories.aiGenerationModel.aggregate([
      { $match: { isCallLog: true, createdAt: { $gte: new Date(Date.now() - d * 86_400_000) } } },
      { $group: { _id: '$toolType', calls: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, tokensIn: { $sum: '$tokensIn' }, tokensOut: { $sum: '$tokensOut' }, costUsd: { $sum: '$costUsd' }, avgLatencyMs: { $avg: '$latencyMs' } } },
      { $sort: { calls: -1 } },
    ]);
    return { success: true, data: { days: d, rows: rows.map((x) => ({ feature: x._id, calls: x.calls, failed: x.failed, tokensIn: x.tokensIn, tokensOut: x.tokensOut, estCostUsd: Math.round(x.costUsd * 10000) / 10000, avgLatencyMs: Math.round(x.avgLatencyMs ?? 0) })) } };
  }

  @Get('moderation/:productId')
  getModeration(@Param('productId', ParseObjectIdPipe) productId: string) {
    return this.moderation.get(productId);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('moderation/:productId')
  runModeration(@Req() req: any, @Param('productId', ParseObjectIdPipe) productId: string) {
    return this.moderation.review(productId, req.user.userId);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('ask')
  ask(@Req() req: any, @Body() dto: QuestionDto) {
    return this.askData.ask(req.user.userId, dto.question);
  }
}

export type { AiFeatureKey };
