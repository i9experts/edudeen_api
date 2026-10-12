import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { AdminReauthController } from './admin-reauth.controller';
import { AdminReauthService } from './admin-reauth.service';
import { AdminReauthGuard } from './admin-reauth.guard';

@Module({
  imports: [RedisModule],
  controllers: [AdminReauthController],
  providers: [AdminReauthService, AdminReauthGuard],
  exports: [AdminReauthService, AdminReauthGuard],
})
export class AdminReauthModule {}