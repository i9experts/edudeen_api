/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { AiStudioController } from './ai-studio.controller';
import { PublicWorksheetTrialController } from './public-worksheet-trial.controller';
import { AiStudioService } from './ai-studio.service';
import { AiStudioCreditsService } from './ai-studio-credits.service';
import { AdminAiStudioController } from './admin-ai-studio.controller';
import { AdminAiStudioService } from './admin-ai-studio.service';
import { TextGenerationService } from './providers/text-generation.service';
import { KeywordDataService } from './providers/keyword-data.service';
import { PricingDataService } from './providers/pricing-data.service';
import { ImageEnhanceService } from './providers/image-enhance.service';
import { AiService } from './core/ai.service';
import { AiFlagsService } from './core/ai-flags.service';
import { AiPublicController, AiSellerController, AiAdminController } from './ai-features.controller';
import { AiCatalogService } from './features/catalog.service';
import { SmartSearchService } from './features/smart-search.service';
import { AssistantService } from './features/assistant.service';
import { ReviewsAiService } from './features/reviews-ai.service';
import { TranslateService } from './features/translate.service';
import { CodRiskService } from './features/cod-risk.service';
import { InsightsService } from './features/insights.service';
import { HelpBotService } from './features/help-bot.service';
import { StudioExtrasService } from './features/studio-extras.service';
import { ModerationAiService } from './features/moderation-ai.service';
import { AskDataService } from './features/ask-data.service';

/**
 * AI Studio — seller-only AI tools (Listing Writer, SEO Booster, Email
 * Campaigns, Worksheet Builder, Price Optimizer, Image Enhancer stub), plus
 * an admin-only counterpart (`AdminAiStudioController`/`AdminAiStudioService`):
 * cross-store oversight of every seller's generations/wallets/transactions,
 * and platform-scope generation (SEO Booster / Email Campaigns / Image
 * Enhancer only) for Edudeen's own marketplace content — never charged
 * against a seller's wallet.
 *
 * Depends on the @Global PlatformPlansModule for AiCreditsService (the wallet
 * is the single balance source; top-ups stay on the existing
 * extra_ai_credits add-on purchase) and the @Global ActivityLogModule — no
 * explicit imports needed for either.
 *
 * RedisModule must be imported alongside AuthModule here — JwtAuthGuard
 * injects RedisService, and every other module using JwtAuthGuard in this
 * codebase imports both (AuthModule exports the guard but not its Redis
 * dependency), so this is required, not redundant.
 * See src/ai-studio/README.md for env vars and provider plug-in points.
 */
@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule],
  controllers: [AiStudioController, PublicWorksheetTrialController, AdminAiStudioController, AiPublicController, AiSellerController, AiAdminController],
  providers: [
    AiStudioService,
    AiStudioCreditsService,
    AdminAiStudioService,
    TextGenerationService,
    KeywordDataService,
    PricingDataService,
    ImageEnhanceService,
    // Phase 5: shared AI gateway + feature services
    AiService, AiFlagsService, AiCatalogService, SmartSearchService, AssistantService, ReviewsAiService, TranslateService,
    CodRiskService, InsightsService, HelpBotService, StudioExtrasService, ModerationAiService, AskDataService,
  ],
  // The scheduler recovers stale credit holds (see SchedulerService.recoverStaleAiStudioHolds).
  exports: [AiStudioCreditsService, AiService, AiFlagsService, SmartSearchService],
})
export class AiStudioModule {}
