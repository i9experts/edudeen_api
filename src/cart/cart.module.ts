import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';

@Module({
  imports: [AuthModule, RedisModule, ExchangeRateModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
