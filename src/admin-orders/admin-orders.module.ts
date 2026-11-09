import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AddressModule } from '../address/address.module';
import { CheckoutModule } from '../checkout/checkout.modoule';
import { PaymentModule } from '../payment/payment.module';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { AdminCreateOrderService } from './admin-create-order.service';

@Module({
  imports: [AuthModule, RedisModule, AddressModule, CheckoutModule, PaymentModule],
  controllers: [AdminOrdersController],
  providers: [AdminOrdersService, AdminCreateOrderService],
})
export class AdminOrdersModule {}
