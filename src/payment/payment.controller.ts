import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Headers,
  UseGuards,
  UseInterceptors,
  RawBodyRequest,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PaymentService } from './payment.service';

@Controller('api/payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // Idempotency-Key protection (previously missing) — a double-tap/retry
  // must never place two separate orders for the same buyer action.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('cod-payment')
  async codPayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.codPayment(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('initiate-payment')
  async initiatePayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.initiatePayment(userId, body);
  }

  // Orders whose grand total is exactly 0 (free resources / fully discounted). The server re-prices and
  // decides eligibility; throttled per client and capped per buyer per day (FREE_ORDERS_PER_USER_PER_DAY).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('free-checkout')
  async freeCheckout(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.freeCheckout(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('status')
  async getPaymentStatus(
    @Req() req: any,
    @Query('checkoutId') checkoutId: string,
  ) {
    const { userId } = req.user;
    return this.paymentService.getPaymentStatus(userId, checkoutId);
  }

  // Stripe calls this directly — no bearer token, trust is the HMAC
  // signature verified in the service via the raw request body.
  @Post('stripe-webhook')
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException(
        'Raw request body unavailable — check rawBody bootstrap config',
      );
    }
    return this.paymentService.stripeWebhook(req.rawBody, signature);
  }
}
