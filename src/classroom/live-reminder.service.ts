/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { LiveReminderLog, LiveReminderLogDocument } from './schemas/live-reminder-log.schema';
import { dueReminderOffset, liveClassBuyerIds, liveClassEmail, reminderCopy, LIVE_REMINDER_OFFSETS } from './live-class.util';

/**
 * Reminds the seller (host) and every buyer of a live class 60, 30, 15 and 5 minutes before it starts.
 * Runs every minute under a Redis lock; each reminder is claimed in `live_reminder_logs` first, so it is never sent twice.
 */
@Injectable()
export class LiveReminderService {
  private readonly logger = new Logger(LiveReminderService.name);

  constructor(
    @InjectModel(LiveReminderLog.name) private readonly logModel: Model<LiveReminderLogDocument>,
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('* * * * *')
  async tick() {
    try {
      const result = await this.redis.withLock('cron-lock:live-class-reminders', 55_000, async () => { await this.run(); });
      if (result === 'lock_not_acquired' && !this.redis.isConnected) this.logger.warn('Skipped live-class reminders - Redis is unavailable');
    } catch (err) {
      this.logger.error(`Live-class reminders failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Public so tests (and a manual run) can drive it with a fixed clock. */
  async run(now = new Date()): Promise<number> {
    const { productModel, orderModel } = this.databaseService.repositories;
    const horizon = new Date(now.getTime() + (Math.max(...LIVE_REMINDER_OFFSETS) + 1) * 60000);
    const classes: any[] = await productModel
      .find({ deliveryFormat: 'live_class', status: 'active', isDelete: false, removedByAdmin: { $ne: true }, 'liveSession.status': { $ne: 'cancelled' }, 'liveSession.startsAt': { $gt: now, $lte: horizon } })
      .select('_id name slug sellerId storeId liveSession')
      .limit(500)
      .lean();
    let sent = 0;
    for (const c of classes) {
      const due = dueReminderOffset(c.liveSession.startsAt, now);
      if (!due) continue;
      const productId = String(c._id);
      const startsAt = new Date(c.liveSession.startsAt);
      const input = { name: c.name, startsAt, meetingUrl: c.liveSession.meetingUrl, platform: c.liveSession.platform };
      const buyers = await liveClassBuyerIds(orderModel as any, productId);
      const recipients: { id: string; role: 'seller' | 'user' }[] = [
        ...(c.sellerId ? [{ id: String(c.sellerId), role: 'seller' as const }] : []),
        ...buyers.filter(b => b !== String(c.sellerId)).map(b => ({ id: b, role: 'user' as const })),
      ];
      for (const rcpt of recipients) {
        if (!(await this.claim(productId, startsAt, rcpt.id, due.offset))) continue;
        const copy = reminderCopy(rcpt.role === 'seller' ? 'seller' : 'buyer', input, due.minutesLeft);
        const path = rcpt.role === 'seller' ? `/store/${c.storeId}/products` : `/product/${c.slug ?? productId}`;
        await this.notifications.notify({
          recipientId: rcpt.id,
          recipientRole: rcpt.role,
          type: NOTIFICATION_TYPES.LIVE_CLASS_REMINDER,
          title: copy.title,
          body: copy.body,
          data: { productId, storeId: c.storeId, offsetMinutes: due.offset, startsAt: startsAt.toISOString(), link: path },
          email: liveClassEmail(copy.title, copy.body, input, { label: rcpt.role === 'seller' ? 'Open my products' : 'Open class page', path }),
        });
        sent++;
      }
    }
    if (sent > 0) this.logger.log(`Live-class reminders sent: ${sent}`);
    return sent;
  }

  /** true = this reminder was not sent yet and is now ours to send. */
  private async claim(productId: string, startsAt: Date, recipientId: string, offsetMinutes: number): Promise<boolean> {
    const res = await this.logModel.updateOne(
      { productId, startsAt, recipientId, offsetMinutes },
      { $setOnInsert: { productId, startsAt, recipientId, offsetMinutes, createdAt: new Date() } },
      { upsert: true },
    );
    return (res.upsertedCount ?? 0) > 0;
  }
}
