import { Module } from '@nestjs/common';
import { productController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductStockService } from './product-stock.service';
import { ProductOffersService } from './product-offers.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { ProductBulkService } from './product-bulk.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { MarketingModule } from 'src/marketing/marketing.module';
import { UploadModule } from 'src/upload/upload.module';
import { AttributesModule } from 'src/attributes/attributes.module';
import { MongooseModule } from '@nestjs/mongoose';
import { StockHistory, StockHistorySchema } from 'src/inventory/stock-history.schema';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminConfigModule,
    MarketingModule,
    UploadModule,
    AttributesModule,
    MongooseModule.forFeature([{ name: StockHistory.name, schema: StockHistorySchema }]),
  ],
  controllers: [productController],
  providers: [ProductsService, ProductStockService, ProductOffersService, ProductLifecycleService, ProductBulkService],
  exports: [ProductsService],
})
export class ProductsModule {}
