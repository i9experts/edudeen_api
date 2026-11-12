import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Store, StoreSchema } from '../store/schemas/store.schema';
import { StoreFollower, StoreFollowerSchema } from '../store/schemas/store-follower.schema';
import { HighlightDaily, HighlightDailySchema, TermDaily, TermDailySchema, VisitDaily, VisitDailySchema } from './visit-daily.schema';
import { VisitsService } from './visits.service';
import { VisitsAdminController, VisitsBeaconController, VisitsStatsController } from './visits.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: VisitDaily.name, schema: VisitDailySchema },
      { name: TermDaily.name, schema: TermDailySchema },
      { name: HighlightDaily.name, schema: HighlightDailySchema },
      { name: StoreFollower.name, schema: StoreFollowerSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Store.name, schema: StoreSchema },
    ]),
  ],
  controllers: [VisitsBeaconController, VisitsStatsController, VisitsAdminController],
  providers: [VisitsService],
})
export class AnalyticsVisitsModule {}
