import { Module } from '@nestjs/common';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminExportsController } from './admin-exports.controller';
import { AdminExportsService } from './admin-exports.service';

@Module({
  imports: [AdminReauthModule, AuthModule, RedisModule],
  controllers: [AdminExportsController],
  providers: [AdminExportsService],
})
export class AdminExportsModule {}
