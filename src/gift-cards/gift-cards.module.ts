import { Module } from '@nestjs/common';
import { GiftCardsController } from './gift-cards.controller';
import { GiftCardsService } from './gift-cards.service';
import { AuthModule } from '../auth/auth.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { EmailService } from '../otp/services/email.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  // RedisModule: required by JwtAuthGuard (RedisService), not re-exported by AuthModule.
  imports: [AuthModule, RedisModule, ExchangeRateModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService, EmailService],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
