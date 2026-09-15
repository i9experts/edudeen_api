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
  controllers: [AiStudioController, PublicWorksheetTrialController, AdminAiStudioController],
  providers: [
    AiStudioService,
    AiStudioCreditsService,
    AdminAiStudioService,
    TextGenerationService,
    KeywordDataService,
    PricingDataService,
    ImageEnhanceService,
  ],
})
export class AiStudioModule {}
