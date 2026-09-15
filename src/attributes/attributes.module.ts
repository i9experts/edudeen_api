import { Module } from '@nestjs/common';
import { AttributesService } from './attributes.service';
import {
  AttributesController,
  CategoryAttributesController,
} from './attributes.controller';
import { ProductAttributesController } from './product-attributes.controller';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [
    CategoryAttributesController,
    AttributesController,
    ProductAttributesController,
  ],
  providers: [AttributesService],
  exports: [AttributesService],
})
export class AttributesModule {}
