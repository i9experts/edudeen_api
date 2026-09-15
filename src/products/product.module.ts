import { Module } from '@nestjs/common';
import { productController } from './products.controller';
import { ProductsService } from './products.service';
import { EducationLevelService } from './education-level.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { MarketingModule } from 'src/marketing/marketing.module';
import { UploadModule } from 'src/upload/upload.module';
import { AttributesModule } from 'src/attributes/attributes.module';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminConfigModule,
    MarketingModule,
    UploadModule,
    AttributesModule,
  ],
  controllers: [productController],
  providers: [ProductsService, EducationLevelService],
  exports: [ProductsService],
})
export class ProductsModule {}
