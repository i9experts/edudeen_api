import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StoreModule } from '../store/store.module';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { StoreTeamModule } from '../store-team/store-team.module';
import { EmailService } from '../otp/services/email.service';
import { AdminStoresController } from './admin-stores.controller';
import { AdminStoresService } from './admin-stores.service';

@Module({
  imports: [AuthModule, RedisModule, StoreModule, AdminReauthModule, StoreTeamModule],
  controllers: [AdminStoresController],
  providers: [AdminStoresService, EmailService],
})
export class AdminStoresModule {}
