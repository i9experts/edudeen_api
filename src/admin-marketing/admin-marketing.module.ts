import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { AdminMarketingController } from './admin-marketing.controller';
import { AdminMarketingService } from './admin-marketing.service';

@Module({
  imports: [AuthModule, RedisModule, AdminReauthModule],
  controllers: [AdminMarketingController],
  providers: [AdminMarketingService],
  exports: [AdminMarketingService],
})
export class AdminMarketingModule {}
