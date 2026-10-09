/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PhoneVerificationService } from './phone-verification.service';

export class SendPhoneCodeDto {
  @IsString() @MaxLength(25) phone: string;
  @IsOptional() @IsIn(['en', 'ur']) lang?: 'en' | 'ur';
}

export class VerifyPhoneCodeDto {
  @IsString() @MaxLength(25) phone: string;
  @IsString() @MaxLength(10) otp: string;
}

@Controller('api/auth/phone')
export class PhoneVerificationController {
  constructor(private readonly phone: PhoneVerificationService) {}

  /** Public: is a WhatsApp/SMS channel configured? (pages hide the option when not) */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('availability')
  availability() {
    return this.phone.availability();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller')
  @Get('status')
  status(@Req() req: any) {
    return this.phone.status(req.user.userId, req.user.role);
  }

  // Per-IP limit here; per-number cooldown/hourly cap + per-account cap live in the service.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller')
  @Post('send')
  send(@Req() req: any, @Body() dto: SendPhoneCodeDto) {
    return this.phone.sendCode(req.user.userId, req.user.role, dto.phone, dto.lang);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller')
  @Post('verify')
  verify(@Req() req: any, @Body() dto: VerifyPhoneCodeDto) {
    return this.phone.verifyCode(req.user.userId, req.user.role, dto.phone, dto.otp);
  }
}
