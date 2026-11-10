import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import {
  buildDispatchRate, buildResponseRate, buildResponseStats, firstInquiry, RESPONSE_WINDOW_DAYS, toDispatchPackage, TRUST_WINDOW_DAYS,
  type DispatchPackage, type FirstInquiry,
} from './response-stats.util';

/**
 * Hourly store trust numbers, cached on the Store doc (nothing is computed per page view):
 *  - Store.responseStats: median first-reply time, last 30 days (shown on product pages)
 *  - Store.trustStats: response rate (answered within 24 h) + dispatch on time (shipped within 48 h of payment), last 90 days
 * Every number needs TRUST_MIN_SAMPLES data points, otherwise it is stored as null.
 */
@Injectable()
export class ResponseStatsService {
  private readonly logger = new Logger(ResponseStatsService.name);

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService) {}

  @Cron('17 * * * *')
  async cronResponseStats() {
    try {
      const r = await this.redis.withLock('cron-lock:store-response-stats', 50 * 60_000, async () => { await this.run(); });
      if (r === 'lock_not_acquired') this.logger.debug('Skipped response stats (lock held or Redis down)');
    } catch (err: any) {
      this.logger.error(`Response stats job failed: ${err?.message}`);
    }
  }

  async run(now = new Date()): Promise<{ stores: number }> {
    const { messageModel, conversationModel, storeModel } = this.db.repositories;
    const since90 = new Date(now.getTime() - TRUST_WINDOW_DAYS * 86_400_000);
    const since30 = now.getTime() - RESPONSE_WINDOW_DAYS * 86_400_000;

    const perConversation: { _id: string; msgs: { senderRole: string; at: Date }[] }[] = await messageModel.aggregate([
      { $match: { createdAt: { $gte: since90 }, isDeleted: { $ne: true }, senderRole: { $in: ['user', 'seller'] } } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$conversationId', msgs: { $push: { senderRole: '$senderRole', at: '$createdAt' } } } },
    ]).allowDiskUse(true);

    const inquiryByConv = new Map<string, FirstInquiry>();
    for (const c of perConversation) {
      const q = firstInquiry(c.msgs);
      if (q) inquiryByConv.set(String(c._id), q);
    }

    const ids = [...inquiryByConv.keys()].filter((id) => isValidObjectId(id));
    const inquiriesByStore = new Map<string, FirstInquiry[]>();
    for (let i = 0; i < ids.length; i += 1000) {
      const convs: any[] = await conversationModel.find({ _id: { $in: ids.slice(i, i + 1000) } }).select('storeId').lean();
      for (const conv of convs) {
        const list = inquiriesByStore.get(conv.storeId) ?? [];
        list.push(inquiryByConv.get(String(conv._id))!);
        inquiriesByStore.set(conv.storeId, list);
      }
    }

    const dispatchByStore = await this.collectDispatchPackages(since90);

    // ── median reply time (30 days), as before but with the shared minimum ──
    const withStats = new Set<string>();
    for (const [storeId, inquiries] of inquiriesByStore) {
      const mins = inquiries.filter((q) => q.replyMinutes !== null && q.inquiryAt >= since30).map((q) => q.replyMinutes as number);
      const stats = buildResponseStats(mins, now);
      if (!stats || !isValidObjectId(storeId)) continue;
      withStats.add(storeId);
      await storeModel.updateOne({ _id: storeId }, { $set: { responseStats: stats } });
    }
    // Stores whose data dropped below the threshold must stop showing an old number.
    await storeModel.updateMany({ responseStats: { $ne: null }, _id: { $nin: [...withStats] } }, { $set: { responseStats: null } });

    // ── response rate + dispatch on time (90 days) ──
    const withTrust = new Set<string>();
    const storeIds = new Set<string>([...inquiriesByStore.keys(), ...dispatchByStore.keys()]);
    for (const storeId of storeIds) {
      if (!isValidObjectId(storeId)) continue;
      const trust = {
        responseRate: buildResponseRate(inquiriesByStore.get(storeId) ?? [], now),
        dispatch: buildDispatchRate(dispatchByStore.get(storeId) ?? [], now),
        updatedAt: now,
      };
      withTrust.add(storeId);
      await storeModel.updateOne({ _id: storeId }, { $set: { trustStats: trust } });
    }
    await storeModel.updateMany({ trustStats: { $ne: null }, _id: { $nin: [...withTrust] } }, { $set: { trustStats: null } });

    return { stores: withStats.size };
  }

  /** Physical packages created in the window, per store. Payment moment = order.paidAt (COD: order creation). */
  private async collectDispatchPackages(since: Date): Promise<Map<string, DispatchPackage[]>> {
    const { orderModel } = this.db.repositories;
    const rows: any[] = await orderModel.aggregate([
      { $match: { createdAt: { $gte: since }, isFreeClaim: { $ne: true } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.items.type': 'physical' } },
      {
        $project: {
          _id: 0,
          storeId: '$sellerOrders.storeId',
          status: '$sellerOrders.status',
          shippedAt: '$sellerOrders.shippedAt',
          dispatchDays: '$sellerOrders.dispatchDays',
          paymentType: 1,
          paidAt: 1,
          createdAt: 1,
        },
      },
    ]).allowDiskUse(true);

    const byStore = new Map<string, DispatchPackage[]>();
    for (const r of rows) {
      if (!r.storeId) continue;
      // Shipped-like but no shipped time (old data): unknown, leave it out rather than guess.
      const pkg = toDispatchPackage(r);
      if (!pkg) continue;
      const list = byStore.get(String(r.storeId)) ?? [];
      list.push(pkg);
      byStore.set(String(r.storeId), list);
    }
    return byStore;
  }
}
