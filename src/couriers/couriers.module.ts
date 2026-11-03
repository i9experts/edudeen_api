import { RedisModule } from '../redis/redis.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { CheckoutModule } from '../checkout/checkout.modoule';
import { CouriersController } from './couriers.controller';
import { CouriersService } from './couriers.service';

@Module({
  imports: [AuthModule, OrdersModule, RedisModule, CheckoutModule],
  controllers: [CouriersController],
  providers: [CouriersService],
})
export class CouriersModule {}
