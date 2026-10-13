/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ChildProfile, ChildProfileSchema } from './children.schema';
import { ChildrenService } from './children.service';
import { ChildrenController } from './children.controller';

// AuthModule + RedisModule: JwtAuthGuard injects RedisService (see CLAUDE.md gotcha).
@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: ChildProfile.name, schema: ChildProfileSchema }])],
  controllers: [ChildrenController],
  providers: [ChildrenService],
})
export class ChildrenModule {}
