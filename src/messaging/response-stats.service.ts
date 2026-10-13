import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { buildResponseStats, firstReplyMinutes, RESPONSE_WINDOW_DAYS } from './response-stats.util';

/** Hourly: median first-reply time of each seller over the last 30 days -> Store.responseStats. */
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
    const since = new Date(now.getTime() - RESPONSE_WINDOW_DAYS * 86_400_000);

    const perConversation: { _id: string; msgs: { senderRole: string; at: Date }[] }[] = await messageModel.aggregate([
      { $match: { createdAt: { $gte: since }, isDeleted: { $ne: true }, senderRole: { $in: ['user', 'seller'] } } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$conversationId', msgs: { $push: { senderRole: '$senderRole', at: '$createdAt' } } } },
    ]).allowDiskUse(true);

    const replyByConv = new Map<string, number>();
    for (const c of perConversation) {
      const mins = firstReplyMinutes(c.msgs);
      if (mins !== null) replyByConv.set(String(c._id), mins);
    }

    const ids = [...replyByConv.keys()].filter((id) => isValidObjectId(id));
    const byStore = new Map<string, number[]>();
    for (let i = 0; i < ids.length; i += 1000) {
      const convs: any[] = await conversationModel.find({ _id: { $in: ids.slice(i, i + 1000) } }).select('storeId').lean();
      for (const conv of convs) {
        const list = byStore.get(conv.storeId) ?? [];
        list.push(replyByConv.get(String(conv._id))!);
        byStore.set(conv.storeId, list);
      }
    }

    const withStats: string[] = [];
    for (const [storeId, mins] of byStore) {
      const stats = buildResponseStats(mins, now);
      if (!stats || !isValidObjectId(storeId)) continue;
      withStats.push(storeId);
      await storeModel.updateOne({ _id: storeId }, { $set: { responseStats: stats } });
    }
    // Stores whose data dropped below the threshold must stop showing an old number.
    await storeModel.updateMany({ responseStats: { $ne: null }, _id: { $nin: withStats } }, { $set: { responseStats: null } });
    return { stores: withStats.length };
  }
}
