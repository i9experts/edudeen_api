/* eslint-disable prettier/prettier */
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as schema from "./schema";

@Injectable()
export class DatabaseService {
  constructor(
    @InjectModel(schema.User.name)
    private userModel: Model<schema.UserDocument>,
    @InjectModel(schema.Seller.name)
    private sellerModel: Model<schema.SellerDocument>,
    @InjectModel(schema.Admin.name)
    private adminModel: Model<schema.AdminDocument>,
    @InjectModel(schema.Category.name)
    private categoryModel: Model<schema.CategoryDocument>,
    @InjectModel(schema.Product.name)
    private productModel: Model<schema.ProductDocument>,

      @InjectModel(schema.ProductVariant.name)
    private productVariantModel: Model<schema.ProductVariantDocument>,

    @InjectModel(schema.EducationLevelAlias.name)
    private educationLevelAliasModel: Model<schema.EducationLevelAliasDocument>,


    @InjectModel(schema.User.name)
    private otpModel: Model<schema.OtpDocument>,
    @InjectModel(schema.Banner.name)
    private bannerModel: Model<schema.BannerDocument>,
    @InjectModel(schema.OnboardingSlide.name)
    private onboardingSlideModel: Model<schema.OnboardingSlideDocument>,
    @InjectModel(schema.User.name)
    private faqModel: Model<schema.FaqDocument>,


     @InjectModel(schema.Cart.name)
    private cartModel: Model<schema.CartDocument>,

    @InjectModel(schema.wishList.name)
    private wishListModel: Model<schema.wishListDocument>,

    @InjectModel(schema.Rating.name)
    private ratingModel: Model<schema.RatingDocument>,

    @InjectModel(schema.Address.name)
    private addressModel: Model<schema.AddressDocument>,

    @InjectModel(schema.UserPaymentMethod.name)
    private userPaymentMethodModel: Model<schema.UserPaymentMethodDocument>,

    @InjectModel(schema.ShippingZone.name)
    private shippingZoneModel: Model<schema.ShippingZoneDocument>,  

    @InjectModel(schema.Checkout.name)
    private checkoutModel: Model<schema.CheckoutDocument>,
    
    @InjectModel(schema.Order.name)
    private orderModel: Model<schema.OrderDocument>,

    @InjectModel(schema.PaymentTransaction.name)
    private paymentTransactionModel: Model<schema.PaymentTransactionDocument>,

    @InjectModel(schema.Store.name)
    private storeModel: Model<schema.StoreDocument>,

    @InjectModel(schema.StoreFollower.name)
    private storeFollowerModel: Model<schema.StoreFollowerDocument>,

    @InjectModel(schema.Employee.name)
    private employeeModel: Model<schema.EmployeeDocument>,

    @InjectModel(schema.RegisterSession.name)
    private registerSessionModel: Model<schema.RegisterSessionDocument>,

    @InjectModel(schema.Sale.name)
    private saleModel: Model<schema.SaleDocument>,

    @InjectModel(schema.PosAuditLog.name)
    private posAuditLogModel: Model<schema.PosAuditLogDocument>,

    @InjectModel(schema.PosSettings.name)
    private posSettingsModel: Model<schema.PosSettingsDocument>,

    @InjectModel(schema.Conversation.name)
    private conversationModel: Model<schema.ConversationDocument>,

    @InjectModel(schema.Message.name)
    private messageModel: Model<schema.MessageDocument>,

    @InjectModel(schema.Block.name)
    private blockModel: Model<schema.BlockDocument>,

    @InjectModel(schema.Report.name)
    private reportModel: Model<schema.ReportDocument>,

    @InjectModel(schema.SellerBalance.name)
    private sellerBalanceModel: Model<schema.SellerBalanceDocument>,

    @InjectModel(schema.Transaction.name)
    private transactionModel: Model<schema.TransactionDocument>,

    @InjectModel(schema.Payout.name)
    private payoutModel: Model<schema.PayoutDocument>,

    @InjectModel(schema.PayoutMethod.name)
    private payoutMethodModel: Model<schema.PayoutMethodDocument>,

    @InjectModel(schema.PayoutSchedule.name)
    private payoutScheduleModel: Model<schema.PayoutScheduleDocument>,

    @InjectModel(schema.TaxReport.name)
    private taxReportModel: Model<schema.TaxReportDocument>,

    @InjectModel(schema.SubscriptionPlan.name)
    private subscriptionPlanModel: Model<schema.SubscriptionPlanDocument>,

    @InjectModel(schema.Subscription.name)
    private subscriptionModel: Model<schema.SubscriptionDocument>,

    @InjectModel(schema.SubscriptionInvoice.name)
    private subscriptionInvoiceModel: Model<schema.SubscriptionInvoiceDocument>,

    @InjectModel(schema.SubscriptionPaymentAttempt.name)
    private subscriptionPaymentAttemptModel: Model<schema.SubscriptionPaymentAttemptDocument>,

    @InjectModel(schema.SubscriptionCounter.name)
    private subscriptionCounterModel: Model<schema.SubscriptionCounterDocument>,

    @InjectModel(schema.WebhookEvent.name)
    private webhookEventModel: Model<schema.WebhookEventDocument>,

    @InjectModel(schema.SubscriptionCreditWallet.name)
    private subscriptionCreditWalletModel: Model<schema.SubscriptionCreditWalletDocument>,

    @InjectModel(schema.SubscriptionNotificationPreference.name)
    private subscriptionNotificationPreferenceModel: Model<schema.SubscriptionNotificationPreferenceDocument>,

    @InjectModel(schema.IdempotencyRecord.name)
    private idempotencyRecordModel: Model<schema.IdempotencyRecordDocument>,

    @InjectModel(schema.PlatformPlan.name)
    private platformPlanModel: Model<schema.PlatformPlanDocument>,

    @InjectModel(schema.SellerPlatformSubscription.name)
    private sellerPlatformSubscriptionModel: Model<schema.SellerPlatformSubscriptionDocument>,

    @InjectModel(schema.PlatformPlanInvoice.name)
    private platformPlanInvoiceModel: Model<schema.PlatformPlanInvoiceDocument>,

    @InjectModel(schema.PlatformPlanPaymentAttempt.name)
    private platformPlanPaymentAttemptModel: Model<schema.PlatformPlanPaymentAttemptDocument>,

    @InjectModel(schema.AiCreditsWallet.name)
    private aiCreditsWalletModel: Model<schema.AiCreditsWalletDocument>,

    @InjectModel(schema.PlatformAddonPurchase.name)
    private platformAddonPurchaseModel: Model<schema.PlatformAddonPurchaseDocument>,

    @InjectModel(schema.StoreLocation.name)
    private storeLocationModel: Model<schema.StoreLocationDocument>,

    @InjectModel(schema.ActivityLog.name)
    private activityLogModel: Model<schema.ActivityLogDocument>,

    @InjectModel(schema.Coupon.name)
    private couponModel: Model<schema.CouponDocument>,

    @InjectModel(schema.LoyaltyProgram.name)
    private loyaltyProgramModel: Model<schema.LoyaltyProgramDocument>,

    @InjectModel(schema.LoyaltyMember.name)
    private loyaltyMemberModel: Model<schema.LoyaltyMemberDocument>,

    @InjectModel(schema.LoyaltyTransaction.name)
    private loyaltyTransactionModel: Model<schema.LoyaltyTransactionDocument>,

    @InjectModel(schema.Reward.name)
    private rewardModel: Model<schema.RewardDocument>,

    @InjectModel(schema.RewardVoucher.name)
    private rewardVoucherModel: Model<schema.RewardVoucherDocument>,

    @InjectModel(schema.GiftCard.name)
    private giftCardModel: Model<schema.GiftCardDocument>,

    @InjectModel(schema.GiftCardTransaction.name)
    private giftCardTransactionModel: Model<schema.GiftCardTransactionDocument>,

    @InjectModel(schema.GiftCardSettings.name)
    private giftCardSettingsModel: Model<schema.GiftCardSettingsDocument>,

    @InjectModel(schema.AutomaticDiscount.name)
    private automaticDiscountModel: Model<schema.AutomaticDiscountDocument>,

    @InjectModel(schema.Collection.name)
    private collectionModel: Model<schema.CollectionDocument>,

    @InjectModel(schema.PlatformSubscription.name)
    private platformSubscriptionModel: Model<schema.PlatformSubscriptionDocument>,

    @InjectModel(schema.PlatformSeoSettings.name)
    private platformSeoSettingsModel: Model<schema.PlatformSeoSettingsDocument>,

    @InjectModel(schema.SeoRedirect.name)
    private seoRedirectModel: Model<schema.SeoRedirectDocument>,

    @InjectModel(schema.SeoCanonicalRule.name)
    private seoCanonicalRuleModel: Model<schema.SeoCanonicalRuleDocument>,

    @InjectModel(schema.SeoLandingPage.name)
    private seoLandingPageModel: Model<schema.SeoLandingPageDocument>,

    @InjectModel(schema.SeoSitemapCache.name)
    private seoSitemapCacheModel: Model<schema.SeoSitemapCacheDocument>,

    @InjectModel(schema.SeoIntegration.name)
    private seoIntegrationModel: Model<schema.SeoIntegrationDocument>,

    @InjectModel(schema.SeoCrawlLog.name)
    private seoCrawlLogModel: Model<schema.SeoCrawlLogDocument>,

    @InjectModel(schema.SeoIndexSnapshot.name)
    private seoIndexSnapshotModel: Model<schema.SeoIndexSnapshotDocument>,

    @InjectModel(schema.SeoAnalyticsSnapshot.name)
    private seoAnalyticsSnapshotModel: Model<schema.SeoAnalyticsSnapshotDocument>,

    @InjectModel(schema.SeoCoreWebVitalsSnapshot.name)
    private seoCoreWebVitalsSnapshotModel: Model<schema.SeoCoreWebVitalsSnapshotDocument>,

    @InjectModel(schema.SeoAiSuggestionLog.name)
    private seoAiSuggestionLogModel: Model<schema.SeoAiSuggestionLogDocument>,

    @InjectModel(schema.SeoAuditResult.name)
    private seoAuditResultModel: Model<schema.SeoAuditResultDocument>,
    @InjectModel(schema.RecentSearch.name)
    private recentSearchModel: Model<schema.RecentSearchDocument>,

    @InjectModel(schema.RecentlyViewed.name)
    private recentlyViewedModel: Model<schema.RecentlyViewedDocument>,

    @InjectModel(schema.AiGeneration.name)
    private aiGenerationModel: Model<schema.AiGenerationDocument>,

    @InjectModel(schema.AiCreditTransaction.name)
    private aiCreditTransactionModel: Model<schema.AiCreditTransactionDocument>,

    @InjectModel(schema.Notification.name)
    private notificationModel: Model<schema.NotificationDocument>,

    @InjectModel(schema.DeviceToken.name)
    private deviceTokenModel: Model<schema.DeviceTokenDocument>,

    @InjectModel(schema.NotificationPreference.name)
    private notificationPreferenceModel: Model<schema.NotificationPreferenceDocument>,

    @InjectModel(schema.PlatformConfig.name)
    private platformConfigModel: Model<schema.PlatformConfigDocument>,

    @InjectModel(schema.Announcement.name)
    private announcementModel: Model<schema.AnnouncementDocument>,

    @InjectModel(schema.Campaign.name)
    private campaignModel: Model<schema.CampaignDocument>,

    @InjectModel(schema.MediaAsset.name)
    private mediaAssetModel: Model<schema.MediaAssetDocument>,

    @InjectModel(schema.StoreBanner.name)
    private storeBannerModel: Model<schema.StoreBannerDocument>,

    @InjectModel(schema.StoreTheme.name)
    private storeThemeModel: Model<schema.StoreThemeDocument>,

    @InjectModel(schema.StorePage.name)
    private storePageModel: Model<schema.StorePageDocument>,

    @InjectModel(schema.BlogPost.name)
    private blogPostModel: Model<schema.BlogPostDocument>,

    @InjectModel(schema.PromotionRequest.name)
    private promotionRequestModel: Model<schema.PromotionRequestDocument>,

    @InjectModel(schema.PromotionDailyStats.name)
    private promotionDailyStatsModel: Model<schema.PromotionDailyStatsDocument>,

    @InjectModel(schema.PromotionClickEvent.name)
    private promotionClickEventModel: Model<schema.PromotionClickEventDocument>,
    @InjectModel(schema.CommissionRule.name)
    private commissionRuleModel: Model<schema.CommissionRuleDocument>,

    @InjectModel(schema.ManualPaymentProof.name)
    private manualPaymentProofModel: Model<schema.ManualPaymentProofDocument>,

    @InjectModel(schema.ExchangeRate.name)
    private exchangeRateModel: Model<schema.ExchangeRateDocument>,

    @InjectModel(schema.StripeWebhookEvent.name)
    private stripeWebhookEventModel: Model<schema.StripeWebhookEventDocument>,

    @InjectModel(schema.RefundRequest.name)
    private refundRequestModel: Model<schema.RefundRequestDocument>,

    @InjectModel(schema.ReconciliationRun.name)
    private reconciliationRunModel: Model<schema.ReconciliationRunDocument>,

    @InjectModel(schema.AttributeDefinition.name)
    private attributeDefinitionModel: Model<schema.AttributeDefinitionDocument>,

    @InjectModel(schema.ProductAttributeValue.name)
    private productAttributeValueModel: Model<schema.ProductAttributeValueDocument>,

  ) { }

  get repositories() {
    return {
      userModel: this.userModel,
      sellerModel: this.sellerModel,
      adminModel: this.adminModel,
      categoryModel: this.categoryModel,
      productModel: this.productModel,
      productVariantModel: this.productVariantModel,
      educationLevelAliasModel: this.educationLevelAliasModel,
      otpModel: this.otpModel,
      bannerModel: this.bannerModel,
      onboardingSlideModel: this.onboardingSlideModel,
      faqModel: this.faqModel,
        
      cartModel: this.cartModel,
      wishListModel: this.wishListModel,
      ratingModel: this.ratingModel,
      addressModel: this.addressModel,
      userPaymentMethodModel: this.userPaymentMethodModel,
      shippingZoneModel: this.shippingZoneModel,
      checkoutModel: this.checkoutModel,
      orderModel: this.orderModel,
      paymentTransactionModel: this.paymentTransactionModel,
      storeModel: this.storeModel,
      storeFollowerModel: this.storeFollowerModel,
      employeeModel: this.employeeModel,
      registerSessionModel: this.registerSessionModel,
      saleModel: this.saleModel,
      posAuditLogModel: this.posAuditLogModel,
      posSettingsModel: this.posSettingsModel,
      conversationModel: this.conversationModel,
      messageModel: this.messageModel,
      blockModel: this.blockModel,
      reportModel: this.reportModel,
      sellerBalanceModel: this.sellerBalanceModel,
      transactionModel: this.transactionModel,
      payoutModel: this.payoutModel,
      payoutMethodModel: this.payoutMethodModel,
      payoutScheduleModel: this.payoutScheduleModel,
      taxReportModel: this.taxReportModel,
      subscriptionPlanModel: this.subscriptionPlanModel,
      subscriptionModel: this.subscriptionModel,
      subscriptionInvoiceModel: this.subscriptionInvoiceModel,
      subscriptionPaymentAttemptModel: this.subscriptionPaymentAttemptModel,
      subscriptionCounterModel: this.subscriptionCounterModel,
      webhookEventModel: this.webhookEventModel,
      subscriptionCreditWalletModel: this.subscriptionCreditWalletModel,
      subscriptionNotificationPreferenceModel: this.subscriptionNotificationPreferenceModel,
      idempotencyRecordModel: this.idempotencyRecordModel,
      platformPlanModel: this.platformPlanModel,
      sellerPlatformSubscriptionModel: this.sellerPlatformSubscriptionModel,
      platformPlanInvoiceModel: this.platformPlanInvoiceModel,
      platformPlanPaymentAttemptModel: this.platformPlanPaymentAttemptModel,
      aiCreditsWalletModel: this.aiCreditsWalletModel,
      platformAddonPurchaseModel: this.platformAddonPurchaseModel,
      storeLocationModel: this.storeLocationModel,
      activityLogModel: this.activityLogModel,
      couponModel: this.couponModel,
      loyaltyProgramModel: this.loyaltyProgramModel,
      loyaltyMemberModel: this.loyaltyMemberModel,
      loyaltyTransactionModel: this.loyaltyTransactionModel,
      rewardModel: this.rewardModel,
      rewardVoucherModel: this.rewardVoucherModel,
      giftCardModel: this.giftCardModel,
      giftCardTransactionModel: this.giftCardTransactionModel,
      giftCardSettingsModel: this.giftCardSettingsModel,
      automaticDiscountModel: this.automaticDiscountModel,
      collectionModel: this.collectionModel,
      platformSubscriptionModel: this.platformSubscriptionModel,
      platformSeoSettingsModel: this.platformSeoSettingsModel,
      seoRedirectModel: this.seoRedirectModel,
      seoCanonicalRuleModel: this.seoCanonicalRuleModel,
      seoLandingPageModel: this.seoLandingPageModel,
      seoSitemapCacheModel: this.seoSitemapCacheModel,
      seoIntegrationModel: this.seoIntegrationModel,
      seoCrawlLogModel: this.seoCrawlLogModel,
      seoIndexSnapshotModel: this.seoIndexSnapshotModel,
      seoAnalyticsSnapshotModel: this.seoAnalyticsSnapshotModel,
      seoCoreWebVitalsSnapshotModel: this.seoCoreWebVitalsSnapshotModel,
      seoAiSuggestionLogModel: this.seoAiSuggestionLogModel,
      seoAuditResultModel: this.seoAuditResultModel,
      recentSearchModel: this.recentSearchModel,
      recentlyViewedModel: this.recentlyViewedModel,
      aiGenerationModel: this.aiGenerationModel,
      aiCreditTransactionModel: this.aiCreditTransactionModel,
      notificationModel: this.notificationModel,
      deviceTokenModel: this.deviceTokenModel,
      notificationPreferenceModel: this.notificationPreferenceModel,
      platformConfigModel: this.platformConfigModel,
      announcementModel: this.announcementModel,
      campaignModel: this.campaignModel,
      mediaAssetModel: this.mediaAssetModel,
      storeBannerModel: this.storeBannerModel,
      storeThemeModel: this.storeThemeModel,
      storePageModel: this.storePageModel,
      blogPostModel: this.blogPostModel,
      promotionRequestModel: this.promotionRequestModel,
      promotionDailyStatsModel: this.promotionDailyStatsModel,
      promotionClickEventModel: this.promotionClickEventModel,
      commissionRuleModel: this.commissionRuleModel,
      manualPaymentProofModel: this.manualPaymentProofModel,
      exchangeRateModel: this.exchangeRateModel,
      stripeWebhookEventModel: this.stripeWebhookEventModel,
      refundRequestModel: this.refundRequestModel,
      reconciliationRunModel: this.reconciliationRunModel,
      attributeDefinitionModel: this.attributeDefinitionModel,
      productAttributeValueModel: this.productAttributeValueModel,
    };
  }
}