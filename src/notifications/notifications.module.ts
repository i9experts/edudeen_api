/* eslint-disable prettier/prettier */
import { WsAuthService } from 'src/common/ws-auth.service';
import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsProcessor } from './notifications.processor';
import { ChannelMessagingService } from './channels/channel-messaging.service';
import { FirebaseAdminService } from '../firebase/firebase.config';
import { EmailService } from '../otp/services/email.service';
import { QueueModule } from '../queues/queue.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

// Global so OrdersService/PaymentService/MessagingService/LoyaltyService/etc.
// can inject NotificationsService directly without importing this module
// everywhere (same pattern as SubscriptionsModule/LoyaltyModule).
//
// AuthModule + RedisModule are required here even though this module doesn't
// call AuthService directly — JwtAuthGuard (used on NotificationsController)
// depends on RedisService for its session check, and any module that uses
// JwtAuthGuard must import both or the guard 500s with
// "Cannot read properties of undefined (reading 'isConnected')" (see
// MessagingModule for the same pattern).
@Global()
@Module({
  imports: [
    ConfigModule,
    QueueModule,
    AuthModule,
    RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway, WsAuthService, NotificationsProcessor, FirebaseAdminService, EmailService, ChannelMessagingService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
