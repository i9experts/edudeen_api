import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  Param,
  Headers,
  UseGuards,
  UseInterceptors,
  RawBodyRequest,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
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

  // ── JazzCash / Easypaisa (PKR hosted checkout) ──
  // Buyer asks to pay: returns the form/redirect the browser follows to the gateway.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('pk/:provider/initiate')
  async startPkPayment(@Req() req: any, @Param('provider') provider: string, @Body() body: any) {
    return this.paymentService.startHostedPayment(req.user.userId, body?.checkoutId, provider);
  }

  // The gateway sends the buyer's browser back here (POST for JazzCash, GET for Easypaisa).
  // Trust comes only from the adapter's verification, never from the browser; the buyer
  // is then redirected to the web app, which polls /status for the final result.
  @Post('pk/:provider/callback')
  async pkCallbackPost(@Param('provider') provider: string, @Body() body: any, @Res() res: Response) {
    return this.finishPkCallback(provider, body, res);
  }

  @Get('pk/:provider/callback')
  async pkCallbackGet(@Param('provider') provider: string, @Query() query: any, @Res() res: Response) {
    return this.finishPkCallback(provider, query, res);
  }

  private async finishPkCallback(provider: string, payload: any, res: Response) {
    let outcome: 'success' | 'failed' | 'invalid' = 'invalid';
    let checkoutId: string | null = null;
    try {
      ({ outcome, checkoutId } = await this.paymentService.handleHostedCallback(provider, payload ?? {}));
    } catch {
      outcome = 'failed';
    }
    const web = (process.env.WEB_APP_URL || 'https://edudeen.com').replace(/\/$/, '');
    const qs = new URLSearchParams({ status: outcome, ...(checkoutId ? { checkoutId } : {}) });
    return res.redirect(302, `${web}/payment/pk-return?${qs.toString()}`);
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
