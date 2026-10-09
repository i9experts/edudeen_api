import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { QUEUE_NAMES, NOTIFICATION_CHANNEL_JOB } from 'src/queues/queue.constants';
import type { ChannelEvent, ChannelId } from './channel.types';
import { buildChannels, planDelivery } from './channel-plan';

export interface ChannelJob {
  channel: ChannelId;
  to: string;
  event: ChannelEvent;
  lang: 'en' | 'ur';
  vars: Record<string, string>;
  text: string;
}

/**
 * Sends order messages over WhatsApp/SMS, only to buyers who opted in. Never throws and never blocks
 * the caller: the actual send is a queued job (inline fallback when Redis is unavailable).
 */
@Injectable()
export class ChannelMessagingService {
  private readonly logger = new Logger(ChannelMessagingService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  async sendOrderEvent(args: {
    userId: string;
    event: ChannelEvent;
    vars: Record<string, string>;
    /** e.g. the order's shipping-address phone, used when the profile has none */
    fallbackPhone?: string | null;
  }): Promise<void> {
    try {
      const channels = buildChannels();
      if (!channels.some((c) => c.isConfigured())) return; // nothing configured: skip all DB work
      const { notificationPreferenceModel, userModel } = this.db.repositories;
      const prefs: any = await notificationPreferenceModel.findOne({ userId: args.userId }).lean();
      if (!prefs || (prefs.whatsappEnabled !== true && prefs.smsEnabled !== true)) return; // opt-in only
      const user: any = await userModel.findById(args.userId).select('phone').lean();
      const plan = planDelivery({
        event: args.event,
        vars: args.vars,
        rawPhone: user?.phone || args.fallbackPhone,
        channels,
        prefs: {
          ordersCategoryEnabled: prefs.prefs?.orders !== false,
          whatsappEnabled: prefs.whatsappEnabled === true,
          smsEnabled: prefs.smsEnabled === true,
          language: prefs.language === 'ur' ? 'ur' : 'en',
        },
      });
      if (!plan) return;
      const job: ChannelJob = { channel: plan.channel, to: plan.to, event: args.event, lang: plan.lang, vars: args.vars, text: plan.text };
      try {
        await this.queue.add(NOTIFICATION_CHANNEL_JOB, job, { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true });
      } catch (err: any) {
        this.logger.warn(`Queue unavailable (${err?.message}); sending channel message inline`);
        await this.deliver(job);
      }
    } catch (err: any) {
      this.logger.error(`sendOrderEvent failed: ${err?.message}`);
    }
  }

  /** Called by the queue processor. Throws on failure so BullMQ retries. */
  async deliver(job: ChannelJob): Promise<void> {
    const channel = buildChannels().find((c) => c.id === job.channel);
    if (!channel || !channel.isConfigured()) return;
    const res = await channel.send({ to: job.to, event: job.event, lang: job.lang, vars: job.vars, text: job.text });
    if (!res.ok) throw new Error(res.error ?? 'channel send failed');
  }
}
