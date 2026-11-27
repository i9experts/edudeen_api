/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { Store, StoreSchema } from '../store/schemas/store.schema';
import { AcademyCourse, AcademyCourseSchema, AcademyProgress, AcademyProgressSchema } from './schemas/academy.schema';
import { AcademyService } from './academy.service';
import { AdminAcademyController, SellerAcademyController } from './academy.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: AcademyCourse.name, schema: AcademyCourseSchema },
      { name: AcademyProgress.name, schema: AcademyProgressSchema },
      { name: Store.name, schema: StoreSchema },
    ]),
  ],
  controllers: [AdminAcademyController, SellerAcademyController],
  providers: [AcademyService],
})
export class AcademyModule {}
