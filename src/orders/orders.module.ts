// import { Module } from '@nestjs/common';
// import { OrdersController } from './orders.controller';
// import { OrdersService } from './orders.service';

// @Module({
//   controllers: [OrdersController],
//   providers: [OrdersService],
// })
// export class OrdersModule {}

import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AuthModule } from 'src/auth/auth.module';
import { UploadModule } from 'src/upload/upload.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';
import { RedisModule } from 'src/redis/redis.module';
import { FinanceModule } from 'src/finance/finance.module';
import { PaymentModule } from 'src/payment/payment.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    AuthModule,
    UploadModule,
    RedisModule,
    FinanceModule,
    PaymentModule,
    ExchangeRateModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
