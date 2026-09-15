import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { categoryModule } from './categories/categories.module';
import { ProductsModule } from './products/product.module';
import { ProductVariantsModule } from './product-variants/product-variants.module';
import { CartModule } from './cart/cart.module';
import { AddressModule } from './address/address.module';
import { UsersModule } from './users/users.module';
import { OtpModule } from './otp/otp.module';
import { UploadModule } from './upload/upload.module';
import { BannersModule } from './banner/banner.module';
import { FaqModule } from './faqs/faq.module';
import { NewsletterModule } from './newsletter/newsletter.module';
import { ContactModule } from './contact/contact.module';
import { TestimonialsModule } from './testimonials/testimonials.module';
import { RefundRequestModule } from './refund-request/refund-request.module';
import { CheckoutModule } from './checkout/checkout.modoule';
import { OrdersModule } from './orders/orders.module';
import { PaymentModule } from './payment/payment.module';
import { StoreModule } from './store/store.module';
import { InventoryModule } from './inventory/inventory.module';
import { RatingModule } from './rating/rating.module';
import { SearchModule } from './search/search.module';
import { PosModule } from './pos/pos.module';
import { MessagingModule } from './messaging/messaging.module';
import { FinanceModule } from './finance/finance.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { MarketingModule } from './marketing/marketing.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { GiftCardsModule } from './gift-cards/gift-cards.module';
import { DiscountsModule } from './discounts/discounts.module';
import { CollectionsModule } from './collections/collections.module';
import { StripeConnectModule } from './stripe-connect/stripe-connect.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PlatformSubscriptionsModule } from './platform-subscriptions/platform-subscriptions.module';
import { AdminAnalyticsModule } from './admin-analytics/admin-analytics.module';
import { AdminFinanceModule } from './admin-finance/admin-finance.module';
import { QueueModule } from './queues/queue.module';
import { HealthModule } from './health/health.module';
import { PlatformPlansModule } from './platform-plans/platform-plans.module';
import { SeoModule } from './seo/seo.module';
import { AiStudioModule } from './ai-studio/ai-studio.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AdminConfigModule } from './admin-config/admin-config.module';
import { AdminAnnouncementsModule } from './admin-announcements/admin-announcements.module';
import { AdminMarketplaceModule } from './admin-marketplace/admin-marketplace.module';
import { AdminModerationModule } from './admin-moderation/admin-moderation.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { AdminMarketingModule } from './admin-marketing/admin-marketing.module';
import { MediaLibraryModule } from './media-library/media-library.module';
import { StoreBannerModule } from './store-banner/store-banner.module';
import { StoreThemeModule } from './store-theme/store-theme.module';
import { StorePagesModule } from './store-pages/store-pages.module';
import { StoreBlogModule } from './store-blog/store-blog.module';
import { PromotionsModule } from './promotions/promotions.module';
import { CommissionRulesModule } from './commission-rules/commission-rules.module';
import { ManualPaymentsModule } from './manual-payments/manual-payments.module';
import { ExchangeRateModule } from './exchange-rate/exchange-rate.module';
import { OnboardingSlidesModule } from './onboarding-slides/onboarding-slides.module';
import { AttributesModule } from './attributes/attributes.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      // Platform-wide default: 100 req/min per IP. Endpoints that need a tighter
      // (payment/webhook) or looser (public browse) limit override via @Throttle().
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),
    DatabaseModule,
    QueueModule,
    NotificationsModule,
    HealthModule,
    ActivityLogModule,
    AuthModule,
    categoryModule,
    AttributesModule,
    ProductsModule,
    ProductVariantsModule,
    CartModule,
    AddressModule,
    UsersModule,
    OtpModule,
    UploadModule,
    BannersModule,
    OnboardingSlidesModule,
    FaqModule,
    NewsletterModule,
    ContactModule,
    TestimonialsModule,
    RefundRequestModule,
    CheckoutModule,
    // checkoutModule,
    OrdersModule,
    // OrdersModule,
    PaymentModule,
    // PaymentProcessingModule,
    StoreModule,
    InventoryModule,
    RatingModule,
    SearchModule,
    PosModule,
    MessagingModule,
    CommissionRulesModule,
    ManualPaymentsModule,
    FinanceModule,
    SubscriptionsModule,
    PlatformPlansModule,
    AiStudioModule,
    SchedulerModule,
    MarketingModule,
    LoyaltyModule,
    GiftCardsModule,
    DiscountsModule,
    CollectionsModule,
    StripeConnectModule,
    AnalyticsModule,
    PlatformSubscriptionsModule,
    AdminAnalyticsModule,
    AdminFinanceModule,
    SeoModule,
    AdminConfigModule,
    AdminAnnouncementsModule,
    AdminMarketplaceModule,
    AdminModerationModule,
    AdminUsersModule,
    AdminMarketingModule,
    MediaLibraryModule,
    StoreBannerModule,
    StoreThemeModule,
    StorePagesModule,
    StoreBlogModule,
    PromotionsModule,
    ExchangeRateModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
