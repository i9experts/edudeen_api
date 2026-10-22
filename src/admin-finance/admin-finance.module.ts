import { Module } from '@nestjs/common';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { FinanceModule } from '../finance/finance.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';

@Module({
  imports: [AdminReauthModule, AuthModule, RedisModule, FinanceModule, AdminConfigModule, ActivityLogModule],
  controllers: [AdminFinanceController],
  providers: [AdminFinanceService],
  exports: [AdminFinanceService],
})
export class AdminFinanceModule {}
