/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PhoneOtp, PhoneOtpSchema } from './phone-otp.schema';
import { PhoneVerificationService } from './phone-verification.service';
import { PhoneVerificationController } from './phone-verification.controller';

/** JwtAuthGuard needs RedisService, so AuthModule + RedisModule are imported (see the MessagingModule note). */
@Module({
  imports: [AuthModule, RedisModule, NotificationsModule, MongooseModule.forFeature([{ name: PhoneOtp.name, schema: PhoneOtpSchema }])],
  controllers: [PhoneVerificationController],
  providers: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
