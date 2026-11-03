/* eslint-disable prettier/prettier */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { QUEUE_NAMES } from 'src/queues/queue.constants';

/**
 * Consumes verified Stripe webhook events (enqueued by StripeWebhookService)
 * and fans them out as internal events. Runs OUTSIDE the Stripe request/
 * response cycle, so slow DB work never risks a Stripe-side webhook timeout/
 * retry storm. BullMQ retries a throwing job with exponential backoff up to
 * the queue's configured `attempts`; once exhausted the job lands in the
 * "failed" state (see `handleFailed`), mirrored onto `WebhookEvent` as a
 * queryable dead-letter record.
 *
 * Deliberately decoupled from any specific feature module: this processor
 * does not import/call `SellerPlatformSubscriptionsService` (seller
 * platform-plan billing) directly, to avoid a dependency cycle. Instead it
 * emits a generic `stripe.<event.type>` event via EventEmitter2; each billing
 * service listens independently (`@OnEvent(...)`) and simply no-ops if the
 * event's subscription id doesn't belong to it.
 */
@Processor(QUEUE_NAMES.STRIPE_WEBHOOKS)
export class StripeWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeWebhookProcessor.name);

  private static readonly ROUTED_EVENT_TYPES = new Set([
    'invoice.payment_succeeded',
    'invoice.payment_failed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
  ]);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<{ eventId: string; type: string }>): Promise<void> {
    const { eventId, type } = job.data;
    const { webhookEventModel } = this.db.repositories;

    const record = await webhookEventModel.findOne({ providerEventId: eventId });
    if (!record) {
      this.logger.warn(`WebhookEvent record missing for ${eventId} — nothing to process`);
      return;
    }
    if (record.status === 'processed') return; // already handled by an earlier attempt

    await webhookEventModel.updateOne({ providerEventId: eventId }, { $set: { status: 'processing' }, $inc: { processingAttempts: 1 } });

    const stripe = this.gateway.stripeClient;
    if (!stripe) throw new Error('Stripe client unavailable while processing a Stripe webhook — provider was switched mid-flight?');

    try {
      // Re-fetch the canonical event object from Stripe rather than trusting
      // the payload snapshot we stored — guards against processing stale data
      // if this job was retried long after the original delivery.
      const event = await stripe.events.retrieve(eventId);
      const object: any = (event.data as any)?.object;

      if (StripeWebhookProcessor.ROUTED_EVENT_TYPES.has(type)) {
        // fan-out — every listener decides for itself whether this event is theirs
        await this.eventEmitter.emitAsync(`stripe.${type}`, object);
      } else if (type === 'charge.refunded' || type === 'charge.dispute.created') {
        // Recorded for audit visibility; no automated state transition —
        // disputes/refund reconciliation is reviewed by an admin.
        this.logger.log(`Stripe event ${type} received (${eventId}) — logged for admin review, no automated action taken`);
      } else {
        await webhookEventModel.updateOne({ providerEventId: eventId }, { $set: { status: 'ignored', processedAt: new Date() } });
        return;
      }

      await webhookEventModel.updateOne({ providerEventId: eventId }, { $set: { status: 'processed', processedAt: new Date(), error: null } });
    } catch (err: any) {
      await webhookEventModel.updateOne({ providerEventId: eventId }, { $set: { status: 'failed', error: err?.message ?? 'Unknown error' } });
      throw err; // let BullMQ's retry/backoff take over
    }
  }

  @OnWorkerEvent('failed')
  handleFailed(job: Job, err: Error) {
    this.logger.error(`Stripe webhook job ${job.id} failed permanently after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
