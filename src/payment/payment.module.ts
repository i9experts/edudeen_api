import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { PromotionsModule } from 'src/promotions/promotions.module';
import { FinanceModule } from 'src/finance/finance.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';
import { GiftCardsModule } from 'src/gift-cards/gift-cards.module';
import { StripeConnectModule } from 'src/stripe-connect/stripe-connect.module';
import { CheckoutModule } from 'src/checkout/checkout.modoule';

@Module({
  // CommissionRulesModule is @Global() (see its own module file) so it
  // doesn't need to be imported here to inject CommissionRulesService.
  imports: [AuthModule, RedisModule, PromotionsModule, FinanceModule, AdminConfigModule, ExchangeRateModule, GiftCardsModule, StripeConnectModule, CheckoutModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
