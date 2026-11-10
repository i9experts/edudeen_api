import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { CategoryRequest, CategoryRequestSchema } from './category-request.schema';
import { CategoryRequestsService } from './category-requests.service';
import { CategoryRequestsController, CategoryRequestsAdminController } from './category-requests.controller';

@Module({
  imports: [AuthModule, RedisModule, AdminReauthModule, MongooseModule.forFeature([{ name: CategoryRequest.name, schema: CategoryRequestSchema }])],
  controllers: [CategoriesController, CategoryRequestsController, CategoryRequestsAdminController],
  providers: [CategoriesService, CategoryRequestsService],
  exports: [CategoriesService],
})
export class categoryModule {}
