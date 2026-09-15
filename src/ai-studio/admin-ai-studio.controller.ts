/* eslint-disable prettier/prettier */
import {
  Body, Controller, Get, Param, Post, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { AdminAiStudioService } from './admin-ai-studio.service';
import { AdminGenerateSeoDto, AdminGenerateEmailDto, AdminGenerateImageEnhanceDto, AdjustWalletDto } from './dto/admin-generate.dto';

/**
 * Admin AI Studio — two halves, both @Roles('admin') only:
 *
 *  - Oversight (read-only): cross-store visibility into every seller's AI
 *    Studio usage — generations, credit transactions, wallet balances.
 *  - Platform generation: SEO Booster / Email Campaigns / Image Enhancer run
 *    for Edudeen's OWN marketplace content, never charged against a seller's
 *    wallet. Listing Writer / Worksheet Builder / Price Optimizer are
 *    seller-product-specific and intentionally excluded here.
 */
@ApiTags('Admin AI Studio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/ai-studio')
export class AdminAiStudioController {
  constructor(private readonly adminAiStudio: AdminAiStudioService) {}

  // ---- oversight ----

  @Get('overview')
  getOverview(@Query('days') days?: string) {
    return this.adminAiStudio.getOverview(Number(days) || 28);
  }

  @Get('generations')
  listGenerations(@Query() query: any) {
    return this.adminAiStudio.listGenerations(query);
  }

  @Get('generations/:generationId')
  getGeneration(@Param('generationId') generationId: string) {
    return this.adminAiStudio.getGeneration(generationId);
  }

  @Get('wallets')
  listWallets(@Query() query: any) {
    return this.adminAiStudio.listWallets(query);
  }

  @Get('wallets/:storeId/ledger')
  getWalletLedger(@Param('storeId') storeId: string) {
    return this.adminAiStudio.getWalletLedger(storeId);
  }

  @Post('wallets/:storeId/adjust')
  adjustWallet(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AdjustWalletDto) {
    return this.adminAiStudio.adjustWallet(storeId, dto, { id: req.user.userId, name: req.user.name, role: req.user.role });
  }

  @Get('transactions')
  listTransactions(@Query() query: any) {
    return this.adminAiStudio.listTransactions(query);
  }

  // ---- platform generation (Edudeen's own content) ----

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('platform/seo-booster/generate')
  generatePlatformSeo(@Req() req: any, @Body() dto: AdminGenerateSeoDto) {
    return this.adminAiStudio.generatePlatformSeo(req.user.userId, dto);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('platform/email-campaigns/generate')
  generatePlatformEmail(@Req() req: any, @Body() dto: AdminGenerateEmailDto) {
    return this.adminAiStudio.generatePlatformEmail(req.user.userId, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('platform/image-enhancer/generate')
  startPlatformImageEnhance(@Req() req: any, @Body() dto: AdminGenerateImageEnhanceDto) {
    return this.adminAiStudio.startPlatformImageEnhance(req.user.userId, dto);
  }

  @Get('platform/image-enhancer/jobs/:jobId')
  getPlatformImageJob(@Param('jobId') jobId: string) {
    return this.adminAiStudio.getPlatformImageJob(jobId);
  }
}
