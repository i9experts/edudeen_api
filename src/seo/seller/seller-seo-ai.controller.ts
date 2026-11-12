/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { IdempotencyInterceptor } from 'src/common/idempotency.interceptor';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoAiService } from '../services/seo-ai.service';
import { GenerateAiSuggestionDto, GenerateAiSuggestionBulkDto, DraftProductSearchTextDto } from '../dto/generate-ai-suggestion.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// AI generation costs real money (AI credits + the underlying Claude API
// call) — idempotency-protected so a client retry never double-charges the
// wallet, and throttled since LLM calls are expensive per-request.
@ApiTags('Seller SEO — AI Suggestions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/ai')
export class SellerSeoAiController {
  constructor(
    private readonly seoAi: SeoAiService,
    private readonly db: DatabaseService,
  ) {}

  @Post('generate')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async generate(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateAiSuggestionDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoAi.generate(dto.entityType, dto.entityId, req.user.userId, { id: req.user.userId, role: req.user.role });
  }

  /** Draft only (nothing saved), 1 credit. Used by the product editor's "Write with AI". */
  @Post('product-draft')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async productDraft(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: DraftProductSearchTextDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoAi.draftProduct(dto.productId, dto.language, storeId, req.user.userId, { id: req.user.userId, role: req.user.role });
  }

  @Post('generate-bulk')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async generateBulk(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateAiSuggestionBulkDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoAi.enqueueBulkGenerate(dto.entityType, dto.entityIds, storeId, req.user.userId, { id: req.user.userId, role: req.user.role });
  }

  @Get('suggestions')
  async getSuggestions(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoAi.getSuggestionHistory(storeId, query);
  }
}
