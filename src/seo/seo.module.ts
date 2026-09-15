/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { FaqModule } from '../faqs/faq.module';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { PlatformSeoService } from './services/platform-seo-settings.service';
import { SeoRedirectsService } from './services/seo-redirects.service';
import { SeoCanonicalService } from './services/seo-canonical.service';
import { SeoResolutionService } from './services/seo-resolution.service';
import { SeoSchemaGeneratorService } from './services/seo-schema-generator.service';
import { SeoContentService } from './services/seo-content.service';
import { SeoLandingPagesService } from './services/seo-landing-pages.service';
import { SeoSitemapService } from './services/seo-sitemap.service';
import { SeoSitemapProcessor } from './seo-sitemap.processor';
import { SeoIntegrationsService } from './services/seo-integrations.service';
import { SeoMonitoringService } from './services/seo-monitoring.service';
import { SeoAdminAnalyticsService } from './services/seo-admin-analytics.service';
import { GoogleSearchConsoleProvider } from './providers/google-search-console.provider';
import { GoogleAnalyticsProvider } from './providers/google-analytics.provider';
import { GoogleMerchantCenterProvider } from './providers/google-merchant-center.provider';
import { BingWebmasterProvider } from './providers/bing-webmaster.provider';
import { AnthropicSeoAiProvider } from './providers/anthropic-seo-ai.provider';
import { SeoAiService } from './services/seo-ai.service';
import { SeoAiProcessor } from './seo-ai.processor';
import { StoreSeoService } from './services/store-seo.service';
import { SeoAuditService } from './services/seo-audit.service';
import { SeoAuditProcessor } from './seo-audit.processor';
import { SeoMetaController, SeoRenderHtmlController } from './public/seo-render.controller';
import { RobotsController } from './public/robots.controller';
import { SitemapController } from './public/sitemap.controller';
import { PlatformSeoController } from './admin/platform-seo.controller';
import { SeoLandingPagesController } from './admin/seo-landing-pages.controller';
import { AdminSeoCategoryController } from './admin/seo-category.controller';
import { AdminSeoFaqController } from './admin/seo-faq.controller';
import { AdminSeoSitemapController } from './admin/seo-sitemap.controller';
import { AdminSeoRedirectsController } from './admin/seo-redirects.controller';
import { AdminSeoCanonicalController } from './admin/seo-canonical.controller';
import { AdminSeoIntegrationsController } from './admin/seo-integrations.controller';
import { AdminSeoMonitoringController } from './admin/seo-monitoring.controller';
import { AdminSeoAnalyticsController } from './admin/seo-analytics.controller';
import { SellerSeoRedirectsController } from './seller/seller-seo-redirects.controller';
import { SellerSeoCanonicalController } from './seller/seller-seo-canonical.controller';
import { SellerSeoAiController } from './seller/seller-seo-ai.controller';
import { SellerStoreSeoController } from './seller/seller-store-seo.controller';
import { SellerProductSeoController } from './seller/seller-product-seo.controller';
import { SellerContentSeoController } from './seller/seller-content-seo.controller';
import { SellerSeoPreviewController } from './seller/seller-seo-preview.controller';
import { SellerSeoAuditController } from './seller/seller-seo-audit.controller';
import { SellerSeoIntegrationsController } from './seller/seller-seo-integrations.controller';
import { SellerSeoAnalyticsController } from './seller/seller-seo-analytics.controller';

/**
 * Root module for the entire SEO capability (Admin/Platform SEO + Seller/
 * Store SEO). Built incrementally phase-by-phase per
 * docs/EDUDEEN_BACKEND_MASTER.md and the SEO architecture plan — controllers
 * and additional providers are added to this file as each phase lands, not
 * split into many small NestJS modules, since everything here shares the
 * same DatabaseService repository access and the same guard imports.
 *
 * Imports `RedisModule` directly (not `AuthModule`) — same deliberate
 * anti-circular-dependency pattern as `ActivityLogModule`/`LoyaltyModule`:
 * `JwtAuthGuard`/`RolesGuard` only need `RedisService` + `Reflector`, not the
 * full auth module. Imports `PlatformPlansModule` for `EntitlementsService`
 * (seller-side feature gating) and, from Phase 6 onward, `AiCreditsService`.
 */
@Module({
  imports: [RedisModule, FaqModule, PlatformPlansModule],
  controllers: [
    // Public delivery — Phase 1, 2 & 3
    SeoMetaController,
    SeoRenderHtmlController,
    RobotsController,
    SitemapController,
    // Admin — Phase 2, 3 & 4
    PlatformSeoController,
    SeoLandingPagesController,
    AdminSeoCategoryController,
    AdminSeoFaqController,
    AdminSeoSitemapController,
    AdminSeoRedirectsController,
    AdminSeoCanonicalController,
    AdminSeoIntegrationsController,
    AdminSeoMonitoringController,
    AdminSeoAnalyticsController,
    // Seller — Phase 3, 6 & 7
    SellerSeoRedirectsController,
    SellerSeoCanonicalController,
    SellerSeoAiController,
    SellerStoreSeoController,
    SellerProductSeoController,
    SellerContentSeoController,
    SellerSeoPreviewController,
    SellerSeoAuditController,
    SellerSeoIntegrationsController,
    SellerSeoAnalyticsController,
  ],
  providers: [
    PlatformSeoService,
    SeoRedirectsService,
    SeoCanonicalService,
    SeoResolutionService,
    SeoSchemaGeneratorService,
    SeoContentService,
    SeoLandingPagesService,
    SeoSitemapService,
    SeoSitemapProcessor,
    SeoIntegrationsService,
    GoogleSearchConsoleProvider,
    GoogleAnalyticsProvider,
    GoogleMerchantCenterProvider,
    BingWebmasterProvider,
    SeoMonitoringService,
    SeoAdminAnalyticsService,
    AnthropicSeoAiProvider,
    SeoAiService,
    SeoAiProcessor,
    StoreSeoService,
    SeoAuditService,
    SeoAuditProcessor,
  ],
  exports: [
    PlatformSeoService,
    SeoRedirectsService,
    SeoCanonicalService,
    SeoResolutionService,
    SeoSchemaGeneratorService,
    SeoContentService,
    SeoLandingPagesService,
    SeoSitemapService,
    SeoIntegrationsService,
    SeoMonitoringService,
    SeoAdminAnalyticsService,
    SeoAiService,
    SeoAuditService,
  ],
})
export class SeoModule {}
