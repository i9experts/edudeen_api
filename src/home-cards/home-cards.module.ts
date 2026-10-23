import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { RedisModule } from '../redis/redis.module';
import { HomeCardsController } from './home-cards.controller';
import { HomeCardsService } from './home-cards.service';
import { HomeCard, HomeCardSchema } from './schemas/home-card.schema';

@Module({
  imports: [AdminReauthModule, RedisModule, MongooseModule.forFeature([{ name: HomeCard.name, schema: HomeCardSchema }])],
  controllers: [HomeCardsController],
  providers: [HomeCardsService],
})
export class HomeCardsModule {}