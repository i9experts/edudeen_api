/* eslint-disable prettier/prettier */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { RedisService } from 'src/redis/redis.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import {
  DONE_PACKAGE_STATUSES, REVIEW_REMINDER_AFTER_DAYS, REVIEW_REMINDER_MAX_PER_RUN, REVIEW_REQUEST_WINDOW_DAYS, reviewReminderDue,
} from './review-request.util';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * Automatic review reminder, 3 days after a package is delivered. Dedupe guard = the same `reviewRequestedAt` the seller's
 * "request a review" button uses (so a buyer gets ONE ask per package, from either path). The claim is an atomic update.
 */
@Injectable()
export class ReviewReminderService {
  private readonly logger = new Logger(ReviewReminderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  @Cron('40 * * * *')
  async cron() {
    try {
      const r = await this.redis.withLock('cron-lock:review-reminders', 10 * 60_000, async () => { await this.run(); });
      if (r === 'lock_not_acquired') this.logger.debug('Skipped review reminders (lock held or Redis down)');
    } catch (err: any) {
      this.logger.error(`Review reminder job failed: ${err?.message}`);
    }
  }

  async run(now = new Date()): Promise<{ checked: number; reminded: number }> {
    const { orderModel, ratingModel, storeModel } = this.db.repositories as any;
    const newest = new Date(now.getTime() - REVIEW_REMINDER_AFTER_DAYS * 86_400_000);
    const oldest = new Date(now.getTime() - REVIEW_REQUEST_WINDOW_DAYS * 86_400_000);
    const orders: any[] = await orderModel
      .find({
        isDelete: { $ne: true },
        sellerOrders: { $elemMatch: { status: { $in: DONE_PACKAGE_STATUSES }, reviewRequestedAt: null, deliveredAt: { $gte: oldest, $lte: newest } } },
      })
      .sort({ updatedAt: 1 }).limit(REVIEW_REMINDER_MAX_PER_RUN * 2)
      .select('orderNumber userId sellerOrders._id sellerOrders.storeId sellerOrders.status sellerOrders.deliveredAt sellerOrders.reviewRequestedAt sellerOrders.items.productId sellerOrders.items.name')
      .lean();

    let checked = 0;
    let reminded = 0;
    for (const order of orders) {
      for (const so of order.sellerOrders ?? []) {
        if (reminded >= REVIEW_REMINDER_MAX_PER_RUN) return { checked, reminded };
        if (!so.deliveredAt || so.reviewRequestedAt || !DONE_PACKAGE_STATUSES.includes(so.status)) continue;
        checked++;
        try {
          const productIds = [...new Set((so.items ?? []).map((i: any) => String(i.productId)))] as string[];
          const rated: any[] = productIds.length && isValidObjectId(String(order.userId))
            ? await ratingModel.find({ userId: String(order.userId), isDelete: false, productId: { $in: productIds } }).select('productId').lean()
            : [];
          const ratedSet = new Set(rated.map(r => String(r.productId)));
          const reviewed = productIds.length > 0 && productIds.every(p => ratedSet.has(p));
          if (!reviewReminderDue({ packageStatus: so.status, doneAt: so.deliveredAt, requestedAt: so.reviewRequestedAt, reviewed, now })) continue;

          // Atomic claim: only one run (or the seller's button) can win this package.
          const res = await orderModel.updateOne(
            { _id: order._id, sellerOrders: { $elemMatch: { _id: so._id, reviewRequestedAt: null } } },
            { $set: { 'sellerOrders.$.reviewRequestedAt': now } },
          );
          if (!res.modifiedCount) continue;

          const store: any = await storeModel.findById(so.storeId).select('name').lean();
          const storeName = String(store?.name ?? 'The seller');
          const first = String(so.items?.[0]?.name ?? 'your order');
          const more = (so.items?.length ?? 0) > 1 ? ` and ${so.items.length - 1} more` : '';
          const body = `How was "${first}"${more} from ${storeName}? A short review helps other families.`;
          await this.notifications?.notify({
            recipientId: String(order.userId), recipientRole: 'user',
            type: NOTIFICATION_TYPES.REVIEW_REQUESTED, title: 'How was your order?', body,
            data: { orderId: String(order._id), orderNumber: order.orderNumber, link: '/account/reviews' },
            email: {
              subject: `How was your order from ${storeName}?`,
              html: `<p>${esc(body)}</p><p><a href="${esc(process.env.WEB_APP_URL || 'https://edudeen.com')}/account/reviews">Write a review</a></p>`,
            },
          } as any);
          reminded++;
        } catch (err: any) {
          this.logger.warn(`review reminder for order ${order._id} failed: ${err?.message}`);
        }
      }
    }
    return { checked, reminded };
  }
}
