/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { FirebaseAdminService } from 'src/firebase/firebase.config';
import { EmailService } from 'src/otp/services/email.service';
import { NotificationsGateway } from './notifications.gateway';
import { QUEUE_NAMES, NOTIFICATION_PUSH_JOB, NOTIFICATION_EMAIL_JOB } from 'src/queues/queue.constants';
import { NOTIFICATION_CATEGORY } from './notification.types';
import { ChannelMessagingService } from './channels/channel-messaging.service';
import type { ChannelEvent } from './channels/channel.types';

import { clampInt } from 'src/common/query-safety.util';
export interface NotifyParams {
  recipientId: string;
  recipientRole: 'user' | 'seller';
  type: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  /** Only set this when the event should also send an email — not every in-app notification warrants one. */
  email?: { subject: string; html: string };
  /** Also send this over WhatsApp/SMS (only to buyers who opted in; ignored when no channel is configured). */
  channelEvent?: { event: ChannelEvent; vars: Record<string, string>; fallbackPhone?: string | null };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly gateway: NotificationsGateway,
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly emailService: EmailService,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) private readonly queue: Queue,
    private readonly channelMessaging: ChannelMessagingService,
  ) {}

  /**
   * Single entry point every other module calls to raise a notification.
   * Never throws — a notification failure must not break the order/payment/
   * message flow that triggered it (same invariant subscription/platform-plan
   * notifications already follow).
   */
  async notify(params: NotifyParams): Promise<void> {
    try {
      const { recipientId, recipientRole, type, title, body, data, email } = params;
      const prefs = await this.databaseService.repositories.notificationPreferenceModel
        .findOne({ userId: recipientId })
        .lean();

      const category = NOTIFICATION_CATEGORY[type];
      const categoryAllowed = !category || !prefs || prefs.prefs?.[category] !== false;

      // Always persist in-app, even if push/email are muted — the inbox is the source of truth.
      const doc = await this.databaseService.repositories.notificationModel.create({
        recipientId,
        recipientRole,
        type,
        title,
        body,
        data: data ?? null,
      });

      this.gateway.emitNewNotification(recipientId, doc.toObject());
      const unreadCount = await this.databaseService.repositories.notificationModel.countDocuments({
        recipientId,
        isRead: false,
      });
      this.gateway.emitUnreadCount(recipientId, unreadCount);

      if (!categoryAllowed) return;

      if (params.channelEvent && recipientRole === 'user') {
        // Fire and forget: opt-in check + queued send happen off this path.
        void this.channelMessaging.sendOrderEvent({ userId: recipientId, ...params.channelEvent });
      }

      const pushEnabled = prefs?.pushEnabled !== false;
      if (pushEnabled) {
        await this.enqueue(NOTIFICATION_PUSH_JOB, { userId: recipientId, title, body, data });
      }

      const emailEnabled = prefs?.emailEnabled !== false;
      if (email && emailEnabled) {
        const user = await this.findRecipient(recipientId, recipientRole);
        if (user?.email) {
          await this.enqueue(NOTIFICATION_EMAIL_JOB, { to: user.email, subject: email.subject, html: email.html });
        }
      }
    } catch (err: any) {
      this.logger.error(`notify() failed: ${err?.message}`);
    }
  }

  private async findRecipient(recipientId: string, recipientRole: 'user' | 'seller') {
    if (recipientRole === 'seller') {
      return this.databaseService.repositories.sellerModel.findById(recipientId).select('email').lean();
    }
    return this.databaseService.repositories.userModel.findById(recipientId).select('email').lean();
  }

  private async enqueue(jobName: string, data: Record<string, any>) {
    try {
      await this.queue.add(jobName, data);
    } catch (err: any) {
      // Redis/BullMQ unavailable — fall back to sending inline rather than silently dropping it.
      this.logger.warn(`Notifications queue unavailable (${err?.message}) — dispatching "${jobName}" inline`);
      if (jobName === NOTIFICATION_PUSH_JOB) {
        await this.firebaseAdminService.sendToUser(data.userId, { title: data.title, body: data.body, data: data.data });
      } else if (jobName === NOTIFICATION_EMAIL_JOB) {
        await this.emailService.sendMail(data.to, data.subject, data.html);
      }
    }
  }

  // ── Inbox REST surface (called by NotificationsController) ────────────────

  async list(userId: string, query: { page?: string; limit?: string; unreadOnly?: string; type?: string }) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, Math.max(1, clampInt(query.limit, 20, 1, 100)));
    const filter: Record<string, any> = { recipientId: userId };
    if (query.unreadOnly === 'true') filter.isRead = false;
    if (query.type) filter.type = query.type;

    const model = this.databaseService.repositories.notificationModel;
    const [items, total, unreadCount] = await Promise.all([
      model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      model.countDocuments(filter),
      model.countDocuments({ recipientId: userId, isRead: false }),
    ]);

    return { success: true, data: { items, total, unreadCount, page, limit } };
  }

  async unreadCount(userId: string) {
    const unreadCount = await this.databaseService.repositories.notificationModel.countDocuments({
      recipientId: userId,
      isRead: false,
    });
    return { success: true, data: { unreadCount } };
  }

  async markRead(userId: string, id: string) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid notification id');
    const doc = await this.databaseService.repositories.notificationModel.findOneAndUpdate(
      { _id: id, recipientId: userId },
      { $set: { isRead: true, readAt: new Date() } },
      { returnDocument: 'after' },
    );
    return { success: true, data: doc };
  }

  async markAllRead(userId: string) {
    await this.databaseService.repositories.notificationModel.updateMany(
      { recipientId: userId, isRead: false },
      { $set: { isRead: true, readAt: new Date() } },
    );
    return { success: true, message: 'All notifications marked as read' };
  }

  async remove(userId: string, id: string) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid notification id');
    await this.databaseService.repositories.notificationModel.deleteOne({ _id: id, recipientId: userId });
    return { success: true, message: 'Notification deleted' };
  }

  // ── Device tokens ───────────────────────────────────────────────────────

  async registerDeviceToken(userId: string, role: string, fcmToken: string, platform: string) {
    if (typeof fcmToken !== 'string' || !fcmToken.trim() || fcmToken.length > 1024) {
      throw new BadRequestException('Invalid device token');
    }
    const { deviceTokenModel } = this.databaseService.repositories;
    await deviceTokenModel.findOneAndUpdate(
      { fcmToken },
      { $set: { userId, role, platform: String(platform ?? '').slice(0, 20), lastUsedAt: new Date() } },
      { upsert: true },
    );
    // At most 10 devices per account (oldest dropped). Unbounded registration let one account collect thousands of
    // tokens — FCM multicast accepts 500 per call, so a >500-token account stopped receiving pushes entirely.
    const MAX_DEVICES = 10;
    const stale = await deviceTokenModel.find({ userId }).sort({ lastUsedAt: -1 }).skip(MAX_DEVICES).select('_id').lean();
    if (stale.length) await deviceTokenModel.deleteMany({ _id: { $in: stale.map((t) => t._id) } });
    return { success: true, message: 'Device token registered' };
  }

  async removeDeviceToken(userId: string, fcmToken: string) {
    await this.databaseService.repositories.deviceTokenModel.deleteOne({ userId, fcmToken });
    return { success: true, message: 'Device token removed' };
  }

  // ── Preferences ─────────────────────────────────────────────────────────

  async getPreferences(userId: string, role: string) {
    // Atomic get-or-create: the web app asks for preferences from more than one
    // place at once, and two parallel find-then-create calls for a brand-new
    // user used to collide on the unique userId index (E11000 → 500).
    const prefs = await this.databaseService.repositories.notificationPreferenceModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { role } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return { success: true, data: prefs };
  }

  async updatePreferences(userId: string, role: string, dto: Record<string, any>) {
    const { pushEnabled, emailEnabled, whatsappEnabled, smsEnabled, language, ...prefFlags } = dto;
    const update: Record<string, any> = {};
    if (pushEnabled !== undefined) update.pushEnabled = pushEnabled;
    if (emailEnabled !== undefined) update.emailEnabled = emailEnabled;
    if (whatsappEnabled !== undefined) update.whatsappEnabled = whatsappEnabled;
    if (smsEnabled !== undefined) update.smsEnabled = smsEnabled;
    if (language === 'en' || language === 'ur') update.language = language;
    for (const [key, value] of Object.entries(prefFlags)) {
      if (value !== undefined) update[`prefs.${key}`] = value;
    }

    const doc = await this.databaseService.repositories.notificationPreferenceModel.findOneAndUpdate(
      { userId },
      { $set: update, $setOnInsert: { role } },
      { upsert: true, returnDocument: 'after' },
    );
    return { success: true, data: doc };
  }
}
