import { RedisModule } from '../redis/redis.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductQuestion, ProductQuestionSchema } from '../classroom/schemas/product-question.schema';
import { StoreDashboardController } from './store-dashboard.controller';
import { StoreDashboardService } from './store-dashboard.service';
import { StoreHealthService } from './store-health.service';

@Module({
  imports: [
    AuthModule, AnalyticsModule, RedisModule,
    MongooseModule.forFeature([{ name: ProductQuestion.name, schema: ProductQuestionSchema }]),
  ],
  controllers: [StoreDashboardController],
  providers: [StoreDashboardService, StoreHealthService],
})
export class StoreDashboardModule {}
