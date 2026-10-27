import { Module } from '@nestjs/common';
import { ExchangeRateService } from './exchange-rate.service';
import { DisplayRateService } from './display-rate.service';
import { ExchangeRateController, AdminFxController } from './exchange-rate.controller';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  // ActivityLogModule is @Global() (see its own module file) so it doesn't
  // need to be re-imported here for ActivityLogService to be injectable.
  // RedisModule: JwtAuthGuard (on AdminFxController) injects RedisService,
  // which AuthModule doesn't re-export — without it the guard is built with
  // no dependencies and every admin FX request 500s.
  imports: [AdminReauthModule, AdminConfigModule, AuthModule, RedisModule],
  controllers: [ExchangeRateController, AdminFxController],
  providers: [ExchangeRateService, DisplayRateService],
  exports: [ExchangeRateService, DisplayRateService],
})
export class ExchangeRateModule {}
