/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { QUEUE_NAMES, STRIPE_WEBHOOK_JOB } from 'src/queues/queue.constants';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly gateway: PaymentGatewayService,
    private readonly db: DatabaseService,
    @InjectQueue(QUEUE_NAMES.STRIPE_WEBHOOKS) private readonly webhookQueue: Queue,
  ) {}

  /**
   * Verifies the Stripe signature, records the event for idempotency/replay
   * protection, and enqueues it for async processing. Returns quickly so
   * Stripe never times out waiting on our actual business logic.
   */
  async receive(rawBody: Buffer, signatureHeader: string | string[] | undefined): Promise<{ received: true } | { received: true; duplicate: true }> {
    const stripe = this.gateway.stripeClient;
    if (!stripe) {
      throw new BadRequestException('Stripe is not the active payment provider');
    }
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new BadRequestException('STRIPE_WEBHOOK_SECRET is not configured');
    }
    if (!signatureHeader || Array.isArray(signatureHeader)) {
      throw new BadRequestException('Missing Stripe-Signature header');
    }

    let event: any;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
    } catch (err: any) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err?.message}`);
      throw new BadRequestException(`Webhook signature verification failed: ${err?.message}`);
    }

    const { webhookEventModel } = this.db.repositories;

    // Replay/duplicate-delivery protection — Stripe explicitly documents that
    // the same event may be delivered more than once.
    try {
      await webhookEventModel.create({
        provider: 'stripe', providerEventId: event.id, type: event.type,
        status: 'received', payload: event.data?.object ?? null,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        // A duplicate is only safe to ignore if the first delivery actually got processed. If it is
        // still 'received', that delivery's enqueue failed (queue/Redis down → 500 → Stripe retry):
        // re-enqueue instead of dropping the event for good. The BullMQ jobId keeps this idempotent.
        const existing = await webhookEventModel.findOne({ provider: 'stripe', providerEventId: event.id }).select('status').lean<{ status: string }>();
        if (existing?.status !== 'received') {
          this.logger.log(`Duplicate Stripe webhook delivery ignored: ${event.id} (${event.type})`);
          return { received: true, duplicate: true };
        }
        this.logger.warn(`Stripe webhook ${event.id} (${event.type}) was recorded but never processed — re-enqueuing`);
      } else {
        throw err;
      }
    }

    await this.webhookQueue.add(STRIPE_WEBHOOK_JOB, { eventId: event.id, type: event.type }, {
      jobId: event.id, // BullMQ-level dedupe on top of our own DB check
    });

    return { received: true };
  }
}
