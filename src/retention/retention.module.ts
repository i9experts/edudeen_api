/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ProductsModule } from '../products/product.module';
import { RetentionService } from './retention.service';
import { AdminRetentionController, ReferralsController, WishlistShareController } from './retention.controller';
import {
  CartReminder, CartReminderSchema, Referral, ReferralCode, ReferralCodeSchema, ReferralSchema,
  RetentionSettings, RetentionSettingsSchema, WishlistShare, WishlistShareSchema, WishlistVariantState, WishlistVariantStateSchema,
} from './retention.schemas';

/**
 * Retention: abandoned-cart reminders, wishlist back-in-stock / price-drop alerts, shareable Saved list, referral programme.
 * NotificationsModule is @Global (NotificationsService); AuthModule + RedisModule are needed because the controllers
 * use JwtAuthGuard (it injects RedisService).
 */
@Module({
  imports: [
    AuthModule,
    RedisModule,
    ProductsModule,
    MongooseModule.forFeature([
      { name: CartReminder.name, schema: CartReminderSchema },
      { name: WishlistVariantState.name, schema: WishlistVariantStateSchema },
      { name: WishlistShare.name, schema: WishlistShareSchema },
      { name: ReferralCode.name, schema: ReferralCodeSchema },
      { name: Referral.name, schema: ReferralSchema },
      { name: RetentionSettings.name, schema: RetentionSettingsSchema },
    ]),
  ],
  controllers: [WishlistShareController, ReferralsController, AdminRetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
