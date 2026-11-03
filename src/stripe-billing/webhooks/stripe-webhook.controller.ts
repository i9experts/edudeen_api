/* eslint-disable prettier/prettier */
import { Controller, Post, Req, Headers, HttpCode, RawBodyRequest, BadRequestException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import { StripeWebhookService } from './stripe-webhook.service';

@ApiTags('Subscriptions — Webhooks')
@Controller('api/subscriptions/webhooks')
export class StripeWebhookController {
  constructor(private readonly webhookService: StripeWebhookService) {}

  // No JwtAuthGuard here by design — Stripe calls this endpoint directly and
  // cannot present a platform bearer token. Trust is established entirely via
  // HMAC signature verification inside StripeWebhookService.receive(), not
  // via the auth layer. Not rate-limited (@SkipThrottle) since Stripe's
  // shared webhook IP ranges could otherwise trip a per-IP limit meant for
  // end users.
  @SkipThrottle()
  @ApiExcludeEndpoint()
  @Post('stripe')
  @HttpCode(200)
  async handleStripeWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    if (!req.rawBody) {
      throw new BadRequestException('Raw request body unavailable — check RawBodyRequest / bootstrap rawBody config');
    }
    return this.webhookService.receive(req.rawBody, signature);
  }
}
