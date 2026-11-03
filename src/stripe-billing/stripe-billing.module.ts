/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { StripeWebhookService } from './webhooks/stripe-webhook.service';
import { StripeWebhookProcessor } from './webhooks/stripe-webhook.processor';
import { QueueModule } from '../queues/queue.module';

// Shared Stripe plumbing for seller platform-plan billing: the gateway
// (customers/prices/subscriptions/portal) and the webhook endpoint + queue
// processor that fans events out as `stripe.<type>` events.
// Global so PlatformPlans services can inject PaymentGatewayService.
@Global()
@Module({
  imports: [QueueModule],
  controllers: [StripeWebhookController],
  providers: [PaymentGatewayService, StripeWebhookService, StripeWebhookProcessor],
  exports: [PaymentGatewayService],
})
export class StripeBillingModule {}
