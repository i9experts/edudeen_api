import { WsAuthService } from 'src/common/ws-auth.service';
import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ActivityLogController } from './activity-log.controller';
import { AdminActivityLogController } from './admin-activity-log.controller';
import { ActivityLogService } from './activity-log.service';
import { ActivityLogGateway } from './activity-log.gateway';
import { RedisModule } from '../redis/redis.module';

// Deliberately does NOT import AuthModule: AuthService injects ActivityLogService
// (a global provider), so importing AuthModule here would create a circular
// module dependency. JwtAuthGuard/RolesGuard only need RedisService + Reflector,
// both satisfied without pulling in the whole AuthModule. The gateway verifies
// socket tokens with its own JwtModule registration instead.
@Global()
@Module({
  imports: [
    RedisModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [ActivityLogController, AdminActivityLogController],
  providers: [ActivityLogService, ActivityLogGateway, WsAuthService],
  exports: [ActivityLogService],
})
export class ActivityLogModule {}
