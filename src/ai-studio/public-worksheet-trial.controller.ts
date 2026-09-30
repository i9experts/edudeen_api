/* eslint-disable prettier/prettier */
import { Body, Controller, HttpException, HttpStatus, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AiStudioService } from './ai-studio.service';
import { GenerateWorksheetTrialDto } from './dto/generate.dto';
import { RedisService } from 'src/redis/redis.service';

/** Platform-wide ceiling on free trial generations per UTC day (each one costs real provider spend). */
const DEFAULT_DAILY_CAP = 300;

/**
 * Public, unauthenticated "Try AI Worksheet Builder for free" — the buyer-
 * facing marketing hook on the Education marketplace page. Deliberately a
 * separate controller from `AiStudioController` (seller-only, credit-metered,
 * store-scoped): this route has no storeId, no wallet, and a hard per-IP
 * rate limit instead, since it's reachable by anyone with no auth.
 */
@ApiTags('AI Studio (Public Trial)')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/public/worksheet-builder')
export class PublicWorksheetTrialController {
  constructor(
    private readonly aiStudio: AiStudioService,
    private readonly redis: RedisService,
  ) {}

  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('try-free')
  async generateTrial(@Body() dto: GenerateWorksheetTrialDto) {
    // The per-IP throttle alone is trivially bypassed (IPv6 rotation, botnets), so
    // also enforce a GLOBAL daily cap. Fails CLOSED if Redis is down — an
    // unauthenticated, unmetered route must never run uncapped.
    const cap = Number(process.env.PUBLIC_TRIAL_DAILY_CAP) || DEFAULT_DAILY_CAP;
    if (!this.redis.isConnected) {
      throw new HttpException('The free trial is temporarily unavailable — please try again later.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const day = new Date().toISOString().slice(0, 10);
    const used = await this.redis.incrWithTtl(`public-worksheet-trial:${day}`, 2 * 24 * 3600);
    if (used > cap) {
      throw new HttpException('The free trial has reached its daily limit — please try again tomorrow.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.aiStudio.generateWorksheetTrial(dto);
  }
}
