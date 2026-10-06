/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { PaymentModule } from '../payment/payment.module';
import { FinanceModule } from '../finance/finance.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { ManualPaymentsController } from './manual-payments.controller';
import { AdminManualPaymentsController } from './admin-manual-payments.controller';
import { SellerManualPaymentsController } from './seller-manual-payments.controller';
import { ManualPaymentsService } from './manual-payments.service';
import { ReceiptCheckService } from './receipt-check.service';

@Module({
  imports: [AuthModule, RedisModule, UploadModule, PaymentModule, FinanceModule, AdminConfigModule],
  controllers: [ManualPaymentsController, AdminManualPaymentsController, SellerManualPaymentsController],
  providers: [ManualPaymentsService, ReceiptCheckService],
  exports: [ManualPaymentsService],
})
export class ManualPaymentsModule {}
