import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { firstInquiry, toDispatchPackage, type DispatchPackage, type FirstInquiry } from '../messaging/response-stats.util';
import { buildStoreHealth, cancellationTrackingStart, countCancellations, type HealthRange } from './store-health.util';

const CACHE_SECONDS = 15 * 60;
const DAY = 86_400_000;

/** Read-only Store Health numbers for the seller. Nothing is tracked or written; results are cached 15 minutes. */
@Injectable()
export class StoreHealthService {
  private readonly logger = new Logger(StoreHealthService.name);

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService) {}

  async getHealth(sellerId: string, storeId: string, range: HealthRange, now = new Date()) {
    const { storeModel } = this.db.repositories;
    const store: any = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('averageRating reviewCount').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const key = `store-health:${storeId}:${range}`;
    try {
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit);
    } catch { /* cache is optional */ }

    const since = new Date(now.getTime() - range * DAY);
    // Counts listings CURRENTLY in status 'rejected' (reviewed in the window). Once an admin approves a
    // sent-back listing its status flips to active, so approvals are (by design) not part of this number.
    const sentBackFilter = { storeId, sellerId, isDelete: false, status: 'rejected', reviewedAt: { $gte: since } };
    const [inquiries, orderStats, cancellation, sentBack, sentBackDocs] = await Promise.all([
      this.collectInquiries(storeId, since),
      this.collectOrderStats(storeId, since),
      this.collectCancellations(storeId, since),
      this.db.repositories.productModel.countDocuments(sentBackFilter),
      this.db.repositories.productModel.find(sentBackFilter).sort({ reviewedAt: -1 }).limit(3).select('title reviewNote').lean(),
    ]);
    const sentBackItems = (sentBackDocs as any[]).map((p) => ({
      id: String(p._id),
      title: String(p.title ?? ''),
      note: p.reviewNote ? String(p.reviewNote).slice(0, 140) : null,
    }));

    const result = {
      ...buildStoreHealth({
        range, now, inquiries,
        packages: orderStats.packages,
        deliveredItems: orderStats.deliveredItems,
        returnedItems: orderStats.returnedItems,
        rating: { average: Number(store.averageRating) || 0, count: Number(store.reviewCount) || 0 },
        sentBack,
        cancellation,
      }),
      sentBackItems,
      generatedAt: now.toISOString(),
    };
    try { await this.redis.set(key, JSON.stringify(result), CACHE_SECONDS); } catch (e: any) { this.logger.debug(`health cache write failed: ${e?.message}`); }
    return result;
  }

  /** First buyer inquiry per conversation of THIS store (same rule as the hourly trust job). */
  private async collectInquiries(storeId: string, since: Date): Promise<FirstInquiry[]> {
    const { conversationModel, messageModel } = this.db.repositories;
    const convs: any[] = await conversationModel.find({ storeId }).select('_id').lean();
    const ids = convs.map((c) => String(c._id));
    const out: FirstInquiry[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const rows: { msgs: { senderRole: string; at: Date }[] }[] = await messageModel.aggregate([
        { $match: { conversationId: { $in: ids.slice(i, i + 1000) }, createdAt: { $gte: since }, isDeleted: { $ne: true }, senderRole: { $in: ['user', 'seller'] } } },
        { $sort: { createdAt: 1 } },
        { $group: { _id: '$conversationId', msgs: { $push: { senderRole: '$senderRole', at: '$createdAt' } } } },
      ]).allowDiskUse(true);
      for (const r of rows) {
        const q = firstInquiry(r.msgs);
        if (q) out.push(q);
      }
    }
    return out;
  }

  /** Seller cancellations: only orders created since `cancelledBy` began to be written (older cancels have no author). */
  private async collectCancellations(storeId: string, since: Date) {
    const { orderModel } = this.db.repositories;
    const from = new Date(Math.max(since.getTime(), cancellationTrackingStart().getTime()));
    const rows: any[] = await orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': storeId, createdAt: { $gte: from }, isFreeClaim: { $ne: true } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.items.type': 'physical' } },
      {
        $project: {
          _id: 0,
          eligible: { $or: [{ $eq: ['$paymentType', 'cash_on_delivery'] }, { $ne: [{ $ifNull: ['$paidAt', null] }, null] }, { $eq: ['$isPaid', true] }] },
          status: '$sellerOrders.status', cancelledBy: { $ifNull: ['$sellerOrders.cancelledBy', null] },
        },
      },
    ]).allowDiskUse(true);
    return countCancellations(rows);
  }

  /** This store's physical packages in the window (free claims never count) + return counts on delivered ones. */
  private async collectOrderStats(storeId: string, since: Date) {
    const { orderModel } = this.db.repositories;
    const rows: any[] = await orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': storeId, createdAt: { $gte: since }, isFreeClaim: { $ne: true } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.items.type': 'physical' } },
      {
        $project: {
          _id: 0, paymentType: 1, paidAt: 1, createdAt: 1,
          status: '$sellerOrders.status', shippedAt: '$sellerOrders.shippedAt',
          items: { $map: { input: { $filter: { input: '$sellerOrders.items', as: 'i', cond: { $eq: ['$$i.type', 'physical'] } } }, as: 'i', in: { status: '$$i.status', returnStatus: '$$i.returnStatus' } } },
        },
      },
    ]).allowDiskUse(true);

    const packages: DispatchPackage[] = [];
    let deliveredItems = 0;
    let returnedItems = 0;
    for (const r of rows) {
      const pkg = toDispatchPackage(r);
      if (pkg) packages.push(pkg);
      if (r.status === 'delivered' || r.status === 'completed') {
        for (const it of r.items ?? []) {
          if (it.status === 'cancelled' || it.status === 'refunded') continue;
          deliveredItems++;
          if (it.returnStatus && it.returnStatus !== 'none') returnedItems++;
        }
      }
    }
    return { packages, deliveredItems, returnedItems };
  }
}
