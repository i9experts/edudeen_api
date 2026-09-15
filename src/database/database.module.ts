import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as schema from './schema';
import { DatabaseService } from './databaseservice';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGO_URI'),
      }),
    }),

    MongooseModule.forFeature([
      { name: schema.User.name, schema: schema.UserSchema },
      { name: schema.Seller.name, schema: schema.SellerSchema },
      { name: schema.Admin.name, schema: schema.AdminSchema },
      { name: schema.Category.name, schema: schema.CategorySchema },
      { name: schema.Product.name, schema: schema.ProductSchema },
      { name: schema.ProductVariant.name, schema: schema.ProductVariantSchema },
      {
        name: schema.EducationLevelAlias.name,
        schema: schema.EducationLevelAliasSchema,
      },
      { name: schema.Cart.name, schema: schema.CartSchema },
      { name: schema.wishList.name, schema: schema.wishListSchema },
      { name: schema.Rating.name, schema: schema.RatingSchema },
      { name: schema.Address.name, schema: schema.AddressSchema },
      {
        name: schema.UserPaymentMethod.name,
        schema: schema.UserPaymentMethodSchema,
      },
      { name: schema.ShippingZone.name, schema: schema.ShippingZoneSchema },
      { name: schema.Checkout.name, schema: schema.CheckoutSchema },
      { name: schema.Order.name, schema: schema.OrderSchema },
      {
        name: schema.PaymentTransaction.name,
        schema: schema.PaymentTransactionSchema,
      },
      { name: schema.Store.name, schema: schema.StoreSchema },
      { name: schema.StoreFollower.name, schema: schema.StoreFollowerSchema },
      { name: schema.Banner.name, schema: schema.BannerSchema },
      { name: schema.OnboardingSlide.name, schema: schema.OnboardingSlideSchema },
      { name: schema.Employee.name, schema: schema.EmployeeSchema },
      {
        name: schema.RegisterSession.name,
        schema: schema.RegisterSessionSchema,
      },
      { name: schema.Sale.name, schema: schema.SaleSchema },
      { name: schema.PosAuditLog.name, schema: schema.PosAuditLogSchema },
      { name: schema.PosSettings.name, schema: schema.PosSettingsSchema },
      { name: schema.Conversation.name, schema: schema.ConversationSchema },
      { name: schema.Message.name, schema: schema.MessageSchema },
      { name: schema.Block.name, schema: schema.BlockSchema },
      { name: schema.Report.name, schema: schema.ReportSchema },
      { name: schema.SellerBalance.name, schema: schema.SellerBalanceSchema },
      { name: schema.Transaction.name, schema: schema.TransactionSchema },
      { name: schema.Payout.name, schema: schema.PayoutSchema },
      { name: schema.PayoutMethod.name, schema: schema.PayoutMethodSchema },
      { name: schema.PayoutSchedule.name, schema: schema.PayoutScheduleSchema },
      { name: schema.TaxReport.name, schema: schema.TaxReportSchema },
      {
        name: schema.SubscriptionPlan.name,
        schema: schema.SubscriptionPlanSchema,
      },
      { name: schema.Subscription.name, schema: schema.SubscriptionSchema },
      {
        name: schema.SubscriptionInvoice.name,
        schema: schema.SubscriptionInvoiceSchema,
      },
      {
        name: schema.SubscriptionPaymentAttempt.name,
        schema: schema.SubscriptionPaymentAttemptSchema,
      },
      {
        name: schema.SubscriptionCounter.name,
        schema: schema.SubscriptionCounterSchema,
      },
      { name: schema.WebhookEvent.name, schema: schema.WebhookEventSchema },
      {
        name: schema.SubscriptionCreditWallet.name,
        schema: schema.SubscriptionCreditWalletSchema,
      },
      {
        name: schema.SubscriptionNotificationPreference.name,
        schema: schema.SubscriptionNotificationPreferenceSchema,
      },
      {
        name: schema.IdempotencyRecord.name,
        schema: schema.IdempotencyRecordSchema,
      },
      { name: schema.PlatformPlan.name, schema: schema.PlatformPlanSchema },
      {
        name: schema.SellerPlatformSubscription.name,
        schema: schema.SellerPlatformSubscriptionSchema,
      },
      {
        name: schema.PlatformPlanInvoice.name,
        schema: schema.PlatformPlanInvoiceSchema,
      },
      {
        name: schema.PlatformPlanPaymentAttempt.name,
        schema: schema.PlatformPlanPaymentAttemptSchema,
      },
      {
        name: schema.AiCreditsWallet.name,
        schema: schema.AiCreditsWalletSchema,
      },
      {
        name: schema.PlatformAddonPurchase.name,
        schema: schema.PlatformAddonPurchaseSchema,
      },
      { name: schema.StoreLocation.name, schema: schema.StoreLocationSchema },
      { name: schema.ActivityLog.name, schema: schema.ActivityLogSchema },
      { name: schema.Coupon.name, schema: schema.CouponSchema },
      { name: schema.LoyaltyProgram.name, schema: schema.LoyaltyProgramSchema },
      { name: schema.LoyaltyMember.name, schema: schema.LoyaltyMemberSchema },
      {
        name: schema.LoyaltyTransaction.name,
        schema: schema.LoyaltyTransactionSchema,
      },
      { name: schema.Reward.name, schema: schema.RewardSchema },
      { name: schema.RewardVoucher.name, schema: schema.RewardVoucherSchema },
      { name: schema.GiftCard.name, schema: schema.GiftCardSchema },
      { name: schema.GiftCardTransaction.name, schema: schema.GiftCardTransactionSchema },
      { name: schema.GiftCardSettings.name, schema: schema.GiftCardSettingsSchema },
      { name: schema.AutomaticDiscount.name, schema: schema.AutomaticDiscountSchema },
      { name: schema.Collection.name, schema: schema.CollectionSchema },
      {
        name: schema.PlatformSubscription.name,
        schema: schema.PlatformSubscriptionSchema,
      },
      {
        name: schema.PlatformSeoSettings.name,
        schema: schema.PlatformSeoSettingsSchema,
      },
      { name: schema.SeoRedirect.name, schema: schema.SeoRedirectSchema },
      {
        name: schema.SeoCanonicalRule.name,
        schema: schema.SeoCanonicalRuleSchema,
      },
      { name: schema.SeoLandingPage.name, schema: schema.SeoLandingPageSchema },
      {
        name: schema.SeoSitemapCache.name,
        schema: schema.SeoSitemapCacheSchema,
      },
      { name: schema.SeoIntegration.name, schema: schema.SeoIntegrationSchema },
      { name: schema.SeoCrawlLog.name, schema: schema.SeoCrawlLogSchema },
      {
        name: schema.SeoIndexSnapshot.name,
        schema: schema.SeoIndexSnapshotSchema,
      },
      {
        name: schema.SeoAnalyticsSnapshot.name,
        schema: schema.SeoAnalyticsSnapshotSchema,
      },
      {
        name: schema.SeoCoreWebVitalsSnapshot.name,
        schema: schema.SeoCoreWebVitalsSnapshotSchema,
      },
      {
        name: schema.SeoAiSuggestionLog.name,
        schema: schema.SeoAiSuggestionLogSchema,
      },
      { name: schema.SeoAuditResult.name, schema: schema.SeoAuditResultSchema },
      { name: schema.RecentSearch.name, schema: schema.RecentSearchSchema },
      { name: schema.RecentlyViewed.name, schema: schema.RecentlyViewedSchema },
      { name: schema.AiGeneration.name, schema: schema.AiGenerationSchema },
      {
        name: schema.AiCreditTransaction.name,
        schema: schema.AiCreditTransactionSchema,
      },
      { name: schema.Notification.name, schema: schema.NotificationSchema },
      { name: schema.DeviceToken.name, schema: schema.DeviceTokenSchema },
      {
        name: schema.NotificationPreference.name,
        schema: schema.NotificationPreferenceSchema,
      },
      { name: schema.PlatformConfig.name, schema: schema.PlatformConfigSchema },
      { name: schema.Announcement.name, schema: schema.AnnouncementSchema },
      { name: schema.Campaign.name, schema: schema.CampaignSchema },
      { name: schema.MediaAsset.name, schema: schema.MediaAssetSchema },
      { name: schema.StoreBanner.name, schema: schema.StoreBannerSchema },
      { name: schema.StoreTheme.name, schema: schema.StoreThemeSchema },
      { name: schema.StorePage.name, schema: schema.StorePageSchema },
      { name: schema.BlogPost.name, schema: schema.BlogPostSchema },
      { name: schema.PromotionRequest.name, schema: schema.PromotionRequestSchema },
      { name: schema.PromotionDailyStats.name, schema: schema.PromotionDailyStatsSchema },
      { name: schema.PromotionClickEvent.name, schema: schema.PromotionClickEventSchema },
      { name: schema.CommissionRule.name, schema: schema.CommissionRuleSchema },
      { name: schema.ManualPaymentProof.name, schema: schema.ManualPaymentProofSchema },
      { name: schema.ExchangeRate.name, schema: schema.ExchangeRateSchema },
      { name: schema.StripeWebhookEvent.name, schema: schema.StripeWebhookEventSchema },
      { name: schema.RefundRequest.name, schema: schema.RefundRequestSchema },
      { name: schema.ReconciliationRun.name, schema: schema.ReconciliationRunSchema },
      { name: schema.AttributeDefinition.name, schema: schema.AttributeDefinitionSchema },
      { name: schema.ProductAttributeValue.name, schema: schema.ProductAttributeValueSchema },
    ]),
  ],
  exports: [MongooseModule, DatabaseService],
  providers: [DatabaseService],
})
export class DatabaseModule {}
