/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { FinanceModule } from '../finance/finance.module';
import { RedisModule } from '../redis/redis.module';
import { SeoModule } from '../seo/seo.module';
import { AdminMarketingModule } from '../admin-marketing/admin-marketing.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { AdminFinanceModule } from '../admin-finance/admin-finance.module';

@Module({
  imports: [ScheduleModule.forRoot(), SubscriptionsModule, FinanceModule, RedisModule, SeoModule, AdminMarketingModule, PromotionsModule, ExchangeRateModule, AdminFinanceModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
