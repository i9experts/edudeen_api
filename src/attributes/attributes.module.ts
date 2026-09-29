import { Module } from '@nestjs/common';
import { AttributesService } from './attributes.service';
import {
  AttributesController,
  CategoryAttributesController,
} from './attributes.controller';
import { ProductAttributesController } from './product-attributes.controller';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  // RedisModule: required by JwtAuthGuard (RedisService), not re-exported by AuthModule.
  imports: [AuthModule, RedisModule],
  controllers: [
    CategoryAttributesController,
    AttributesController,
    ProductAttributesController,
  ],
  providers: [AttributesService],
  exports: [AttributesService],
})
export class AttributesModule {}
