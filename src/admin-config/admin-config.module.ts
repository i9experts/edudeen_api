import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigController } from './admin-config.controller';
import { PublicPlatformConfigController } from './public-platform-config.controller';
import { AdminConfigService } from './admin-config.service';
import { FeatureFlagGuard } from './guards/feature-flag.guard';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AdminConfigController, PublicPlatformConfigController],
  providers: [AdminConfigService, FeatureFlagGuard],
  exports: [AdminConfigService, FeatureFlagGuard],
})
export class AdminConfigModule {}
