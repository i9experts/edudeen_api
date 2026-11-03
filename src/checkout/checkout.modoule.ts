// import { Module } from '@nestjs/common';
// import { checkoutService } from './checkout.service';
// import { checkoutController } from './checkout.controller';
// import { DatabaseModule } from 'src/database/database.module';
// import { AuthModule } from 'src/auth/auth.module';
// import { RedisModule } from 'src/redis/redis.module';

// @Module({
//   imports: [AuthModule, RedisModule],
//   controllers: [checkoutController],
//   providers: [checkoutService],
//   exports: [checkoutService],
// })
// export class checkoutModule {}

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CheckoutService } from './checkout.service';
import { ShippingRatesService } from './shipping-rates.service';
import { ShippingQuoteService } from './shipping-quote.service';
import { ShippingRateTable, ShippingRateTableSchema } from './shipping.schema';
import { CheckoutController } from './checkout.controller';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { MarketingModule } from 'src/marketing/marketing.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';
import { GiftCardsModule } from 'src/gift-cards/gift-cards.module';
import { DiscountsModule } from 'src/discounts/discounts.module';

@Module({
  imports: [
    AuthModule, RedisModule, MarketingModule, AdminConfigModule, ExchangeRateModule, GiftCardsModule, DiscountsModule,
    MongooseModule.forFeature([{ name: ShippingRateTable.name, schema: ShippingRateTableSchema }]),
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService, ShippingRatesService, ShippingQuoteService],
  exports: [CheckoutService, ShippingRatesService, ShippingQuoteService],
})
export class CheckoutModule {}
