import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminPendingController } from './admin-pending.controller';
import { StoreLookupController } from './store-lookup.controller';
import { AdminPendingService } from './admin-pending.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AdminPendingController, StoreLookupController],
  providers: [AdminPendingService],
  exports: [AdminPendingService],
})
export class AdminPendingModule {}
