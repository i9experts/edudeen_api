import { RedisModule } from '../redis/redis.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { StoreDashboardController } from './store-dashboard.controller';
import { StoreDashboardService } from './store-dashboard.service';

@Module({
  imports: [AuthModule, AnalyticsModule, RedisModule],
  controllers: [StoreDashboardController],
  providers: [StoreDashboardService],
})
export class StoreDashboardModule {}
