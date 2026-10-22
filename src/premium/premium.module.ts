/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { PremiumService } from './premium.service';
import { PremiumEntitlementsService } from './premium-entitlements.service';
import { AdminPremiumController, PremiumController } from './premium.controller';
import {
  PremiumCouponIssue, PremiumCouponIssueSchema, PremiumMembership, PremiumMembershipSchema, PremiumPayment, PremiumPaymentSchema, PremiumPlan, PremiumPlanSchema,
  PremiumSettings, PremiumSettingsSchema,
} from './premium.schemas';

/**
 * Edudeen Premium (buyer membership). @Global so children / products / checkout / cart / contact / retention can inject
 * PremiumEntitlementsService as an OPTIONAL dependency without importing this module (no circular imports).
 * AuthModule + RedisModule: the controllers use JwtAuthGuard (it injects RedisService - see CLAUDE.md gotcha).
 */
@Global()
@Module({
  imports: [
    AdminReauthModule, AuthModule, RedisModule, UploadModule, AdminConfigModule, ExchangeRateModule,
    MongooseModule.forFeature([
      { name: PremiumPlan.name, schema: PremiumPlanSchema },
      { name: PremiumMembership.name, schema: PremiumMembershipSchema },
      { name: PremiumPayment.name, schema: PremiumPaymentSchema },
      { name: PremiumCouponIssue.name, schema: PremiumCouponIssueSchema },
      { name: PremiumSettings.name, schema: PremiumSettingsSchema },
    ]),
  ],
  controllers: [PremiumController, AdminPremiumController],
  providers: [PremiumService, PremiumEntitlementsService],
  exports: [PremiumService, PremiumEntitlementsService],
})
export class PremiumModule {}
