/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { PlatformPlansController } from './platform-plans.controller';
import { SellerPlatformSubscriptionsController } from './seller-platform-subscriptions.controller';
import { PlatformAddonsController } from './platform-addons.controller';
import { PlatformPlansService } from './platform-plans.service';
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import { AiCreditsService } from './ai-credits.service';
import { PlatformAddonsService } from './platform-addons.service';
import { PlatformPlanNotificationsService } from './platform-plan-notifications.service';
import { AuthModule } from '../auth/auth.module';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { RedisModule } from '../redis/redis.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { EmailService } from '../otp/services/email.service';

// @Global() so any module (Products, Employee/POS, Store, Loyalty, Finance,
// the buyer-facing Subscriptions module) can inject EntitlementsService /
// AiCreditsService to gate a feature behind a platform-plan tier, without
// each of those modules needing to import this one explicitly — identical
// reasoning to why SubscriptionsModule/ActivityLogModule are global.
@Global()
@Module({
  imports: [AdminReauthModule, AuthModule, RedisModule, SubscriptionsModule],
  // Controller order matters here — Express/Nest routing is first-match, in
  // controller-then-method declaration order (same "static-before-dynamic"
  // convention used throughout this codebase's other controllers):
  //   1. PlatformAddonsController's static "admin/addons" must come before
  //      PlatformPlansController's parameterized "admin/:id".
  //   2. PlatformPlansController's static "public"/"admin/*" routes must come
  //      before SellerPlatformSubscriptionsController's catch-all ":storeId".
  controllers: [PlatformAddonsController, PlatformPlansController, SellerPlatformSubscriptionsController],
  providers: [
    PlatformPlansService,
    SellerPlatformSubscriptionsService,
    EntitlementsService,
    AiCreditsService,
    PlatformAddonsService,
    PlatformPlanNotificationsService,
    EmailService,
  ],
  exports: [PlatformPlansService, SellerPlatformSubscriptionsService, EntitlementsService, AiCreditsService, PlatformAddonsService],
})
export class PlatformPlansModule {}
