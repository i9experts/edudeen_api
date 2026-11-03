import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Central BullMQ wiring — one Redis connection, shared by every named queue.
 * `@Global()` so any module can `@InjectQueue(QUEUE_NAMES.X)` without
 * re-importing this module everywhere (same pattern as ActivityLogModule).
 *
 * Why queues at all: Stripe expects a webhook response within ~10s or it
 * retries the delivery. Doing the real DB work (transactional plan
 * update + notification) synchronously inside the
 * webhook request risks a timeout under load, which would cause Stripe to
 * redeliver a webhook whose side effects may have partially completed.
 * Instead the controller only verifies + persists the raw event, enqueues a
 * job, and returns 200 immediately; a worker processes it with BullMQ's
 * built-in exponential-backoff retry — and a `failed` listener demotes
 * exhausted jobs into a queryable dead-letter record (see
 * `WebhookEvent.status = 'failed'`) instead of silently vanishing.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL') || 'redis://localhost:6379',
          maxRetriesPerRequest: null, // required by BullMQ's blocking connections
        },
      }),
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.STRIPE_WEBHOOKS,
        defaultJobOptions: {
          attempts: 6,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: false, // keep failed jobs visible for the dead-letter view
        },
      },
      {
        // Building a full multi-store, chunked product sitemap can be slow —
        // triggered by cron + manual admin/seller "regenerate" action.
        name: QUEUE_NAMES.SEO_SITEMAP,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      },
      {
        // Audit runs call external PSI/CWV APIs with real latency.
        name: QUEUE_NAMES.SEO_AUDIT,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 1000 },
        },
      },
      {
        // AI generation is credit-metered per item — its own queue so retry/
        // backoff tuning doesn't have to compromise between "cheap audit
        // check" and "costs real AI-credit-wallet money" semantics.
        name: QUEUE_NAMES.SEO_AI,
        defaultJobOptions: {
          attempts: 2, // don't retry a credit-consuming call many times on failure
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 1000 },
        },
      },
      {
        // Push/email dispatch for the Notifications module — kept off the request
        // path so a slow FCM/SMTP call never blocks the order/message/etc. flow
        // that triggered the notification.
        name: QUEUE_NAMES.NOTIFICATIONS,
        defaultJobOptions: {
          attempts: 4,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { count: 5000 },
          removeOnFail: { count: 5000 },
        },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
