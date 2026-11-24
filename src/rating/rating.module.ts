import { Module } from '@nestjs/common';
import { RatingService } from './rating.service';
import { RatingController } from './rating.controller';
import { RatingSellerService } from './rating-seller.service';
import { ReviewReminderService } from './review-reminder.service';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule],
  controllers: [RatingController],
  providers: [RatingService, RatingSellerService, ReviewReminderService],
})
export class RatingModule {}
