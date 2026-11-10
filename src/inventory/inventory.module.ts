import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { MongooseModule } from '@nestjs/mongoose';
import { VisitDaily, VisitDailySchema } from '../analytics-visits/visit-daily.schema';
import { StockHistory, StockHistorySchema } from './stock-history.schema';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule, MongooseModule.forFeature([
    { name: VisitDaily.name, schema: VisitDailySchema },
    { name: StockHistory.name, schema: StockHistorySchema },
  ])],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
