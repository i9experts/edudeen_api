import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { QUEUE_NAMES, NOTIFICATION_CHANNEL_JOB } from 'src/queues/queue.constants';
import { RETENTION_EVENTS, type ChannelEvent, type ChannelId } from './channel.types';
import { buildChannels, planDelivery } from './channel-plan';
import { renderMessage } from './message-templates';

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
      // Order updates follow the orders category; retention messages (cart reminder, price alerts, referral)
      // need the promotions category AND the separate retention opt-in, so an order-updates opt-in never starts marketing.
      const categoryEnabled = RETENTION_EVENTS.has(args.event)
        ? prefs.prefs?.promotions !== false && prefs.retentionChannelsEnabled === true
        : prefs.prefs?.orders !== false;
      const plan = planDelivery({
        event: args.event,
        vars: args.vars,
        rawPhone: user?.phone || args.fallbackPhone,
        channels,
        prefs: {
          ordersCategoryEnabled: categoryEnabled,
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

  /** True when at least one out-of-app channel (WhatsApp/SMS) is configured on this server. */
  isAnyChannelConfigured(): boolean {
    return buildChannels().some((c) => c.isConfigured());
  }

  /**
   * Account-verification delivery (phone OTP). NOT preference-gated (the user asked for it) and NOT queued/retried
   * (a stale code is useless): WhatsApp first, SMS as fallback. Returns ok=false instead of throwing; the code is
   * never logged.
   */
  async sendDirect(args: { to: string; event: ChannelEvent; vars: Record<string, string>; lang?: 'en' | 'ur' }): Promise<{ ok: boolean; channel?: ChannelId; error?: string }> {
    const lang = args.lang === 'ur' ? 'ur' : 'en';
    const text = renderMessage(args.event, lang, args.vars);
    for (const channel of buildChannels()) {
      if (!channel.isConfigured()) continue;
      try {
        const res = await channel.send({ to: args.to, event: args.event, lang, vars: args.vars, text });
        if (res.ok) return { ok: true, channel: channel.id };
        this.logger.warn(`${channel.id} direct send failed: ${String(res.error ?? '').slice(0, 80)}`);
      } catch (err: any) {
        this.logger.warn(`${channel.id} direct send threw: ${String(err?.message ?? '').slice(0, 80)}`);
      }
    }
    return { ok: false, error: 'no_channel_delivered' };
  }

  /** Called by the queue processor. Throws on failure so BullMQ retries. */
  async deliver(job: ChannelJob): Promise<void> {
    const channel = buildChannels().find((c) => c.id === job.channel);
    if (!channel || !channel.isConfigured()) return;
    const res = await channel.send({ to: job.to, event: job.event, lang: job.lang, vars: job.vars, text: job.text });
    if (!res.ok) throw new Error(res.error ?? 'channel send failed');
  }
}
