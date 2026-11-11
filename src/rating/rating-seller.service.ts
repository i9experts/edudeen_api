/* eslint-disable prettier/prettier */
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { randomUUID } from 'crypto';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import {
  DONE_PACKAGE_STATUSES, REVIEW_REQUEST_REASON_TEXT, REVIEW_REQUEST_WINDOW_DAYS, REPORT_REASONS,
  cleanReport, reviewRequestBlock, trustedProgress,
} from './review-request.util';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

@Injectable()
export class RatingSellerService {
  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private get r() { return this.db.repositories; }

  private async ownStore(storeId: string, sellerId: string, role: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid store id');
    const filter: any = { _id: storeId, isDelete: false };
    if (role !== 'admin') filter.sellerId = sellerId;
    const store: any = await this.r.storeModel.findOne(filter).select('name sellerId reviewReplyTemplates').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  // ── reply templates (max 5 per store) ─────────────────────────────────────
  async getTemplates(sellerId: string, role: string, storeId: string) {
    const store = await this.ownStore(storeId, sellerId, role);
    return { success: true, data: { templates: store.reviewReplyTemplates ?? [] } };
  }

  async saveTemplates(sellerId: string, role: string, storeId: string, raw: any[]) {
    await this.ownStore(storeId, sellerId, role);
    if (!Array.isArray(raw) || raw.length > 5) throw new BadRequestException('You can save up to 5 templates');
    const clean = raw.map((t: any) => ({
      id: typeof t?.id === 'string' && t.id.length > 0 && t.id.length <= 40 ? t.id : randomUUID(),
      title: String(t?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      text: String(t?.text ?? '').trim().slice(0, 800),
    }));
    if (clean.some(t => !t.title || t.text.length < 5)) throw new BadRequestException('Each template needs a title and text (5+ characters)');
    await this.r.storeModel.updateOne({ _id: storeId }, { $set: { reviewReplyTemplates: clean } });
    return { success: true, data: { templates: clean } };
  }

  // ── request a review ──────────────────────────────────────────────────────
  private async reviewedKeys(storeId: string, buyerIds: string[]) {
    const rows: any[] = buyerIds.length
      ? await this.r.ratingModel.find({ storeId, isDelete: false, userId: { $in: buyerIds } }).select('userId productId orderId').lean()
      : [];
    return new Set(rows.map(x => `${x.userId}:${x.productId}`));
  }

  private packageFacts(order: any, so: any, reviewed: Set<string>) {
    const productIds = [...new Set((so.items ?? []).map((i: any) => String(i.productId)))] as string[];
    const allReviewed = productIds.length > 0 && productIds.every(p => reviewed.has(`${order.userId}:${p}`));
    return reviewRequestBlock({
      packageStatus: so.status, doneAt: so.deliveredAt ?? order.updatedAt ?? order.createdAt,
      requestedAt: so.reviewRequestedAt, reviewed: allReviewed,
    });
  }

  /** Seller's recent completed orders with the state of the review request (modal list). */
  async listRequestable(sellerId: string, role: string, storeId: string) {
    await this.ownStore(storeId, sellerId, role);
    const since = new Date(Date.now() - 2 * REVIEW_REQUEST_WINDOW_DAYS * 86_400_000);
    const orders: any[] = await this.r.orderModel
      .find({ isDelete: { $ne: true }, createdAt: { $gte: since }, sellerOrders: { $elemMatch: { storeId, status: { $in: DONE_PACKAGE_STATUSES } } } })
      .sort({ createdAt: -1 }).limit(100)
      .select('orderNumber userId createdAt updatedAt sellerOrders._id sellerOrders.storeId sellerOrders.status sellerOrders.deliveredAt sellerOrders.reviewRequestedAt sellerOrders.items.productId sellerOrders.items.name')
      .lean();
    const buyerIds = [...new Set(orders.map(o => String(o.userId)))].filter(id => isValidObjectId(id));
    const [reviewed, users] = await Promise.all([
      this.reviewedKeys(storeId, buyerIds),
      buyerIds.length ? this.r.userModel.find({ _id: { $in: buyerIds } }).select('name').lean() : Promise.resolve([] as any[]),
    ]);
    const nameOf = new Map((users as any[]).map(u => [String(u._id), u.name as string]));
    const items = orders.map(o => {
      const so = (o.sellerOrders ?? []).find((s: any) => String(s.storeId) === storeId && DONE_PACKAGE_STATUSES.includes(s.status));
      if (!so) return null;
      const block = this.packageFacts(o, so, reviewed);
      return {
        orderId: String(o._id), orderNumber: o.orderNumber, buyerName: nameOf.get(String(o.userId)) ?? 'Customer',
        productName: so.items?.[0]?.name ?? '', itemCount: so.items?.length ?? 0,
        date: so.deliveredAt ?? o.updatedAt ?? o.createdAt,
        requestedAt: so.reviewRequestedAt ?? null,
        eligible: block === null, blockedReason: block, blockedText: block ? REVIEW_REQUEST_REASON_TEXT[block] : null,
      };
    }).filter(Boolean);
    return { success: true, data: { items, windowDays: REVIEW_REQUEST_WINDOW_DAYS } };
  }

  async requestReview(sellerId: string, orderId: string) {
    if (!isValidObjectId(orderId)) throw new BadRequestException('Invalid order id');
    const order: any = await this.r.orderModel.findOne({ _id: orderId, isDelete: { $ne: true } }).lean();
    if (!order) throw new NotFoundException('Order not found');
    // Ownership = the package's store belongs to this seller (same rule as the order screens).
    const ownStores: any[] = await this.r.storeModel.find({ sellerId, isDelete: false }).select('_id').lean();
    const mine = new Set(ownStores.map(s => String(s._id)));
    const so = (order.sellerOrders ?? []).find((s: any) => mine.has(String(s.storeId)));
    if (!so) throw new ForbiddenException('This order does not belong to your store');

    const reviewed = await this.reviewedKeys(String(so.storeId), [String(order.userId)]);
    const block = this.packageFacts(order, so, reviewed);
    if (block === 'already_requested') throw new ConflictException('A review was already requested for this order');
    if (block) throw new UnprocessableEntityException(REVIEW_REQUEST_REASON_TEXT[block]);

    // Atomic: only one request can win, even with a double click.
    const res = await this.r.orderModel.updateOne(
      { _id: orderId, sellerOrders: { $elemMatch: { _id: so._id, reviewRequestedAt: null } } },
      { $set: { 'sellerOrders.$.reviewRequestedAt': new Date() } },
    );
    if (!res.modifiedCount) throw new ConflictException('A review was already requested for this order');

    const store: any = await this.r.storeModel.findById(so.storeId).select('name').lean();
    const storeName = String(store?.name ?? 'The seller');
    const first = String(so.items?.[0]?.name ?? 'your order');
    const more = (so.items?.length ?? 0) > 1 ? ` and ${so.items.length - 1} more` : '';
    // Fixed template on purpose: the seller cannot add text (no incentives, no pressure).
    const title = 'How was your order?';
    const body = `${storeName} would love your feedback on "${first}"${more}. It takes a minute and helps other families.`;
    void this.notifications?.notify({
      recipientId: String(order.userId), recipientRole: 'user',
      type: NOTIFICATION_TYPES.REVIEW_REQUESTED, title, body,
      data: { orderId: String(order._id), orderNumber: order.orderNumber, link: '/account/reviews' },
      email: {
        subject: `How was your order from ${storeName}?`,
        html: `<p>${esc(body)}</p><p><a href="${esc(process.env.WEB_APP_URL || 'https://edudeen.com')}/account/reviews">Write a review</a></p>`,
      },
    } as any);
    this.activity?.log({
      storeId: String(so.storeId), category: 'orders', action: 'review_requested',
      description: `Review requested for order ${order.orderNumber}`, actorId: sellerId, actorRole: 'seller',
      targetId: String(order._id), targetType: 'order',
    } as any);
    return { success: true, message: 'Review request sent' };
  }

  // ── report a review ───────────────────────────────────────────────────────
  async reportReview(sellerId: string, reviewId: string, dto: { reasonCode?: string; text?: string }) {
    const review: any = await this.r.ratingModel.findOne({ _id: reviewId, isDelete: false }).lean();
    if (!review) throw new NotFoundException('Review not found');
    const store: any = review.storeId
      ? await this.r.storeModel.findOne({ _id: review.storeId, sellerId, isDelete: false }).select('_id').lean()
      : null;
    if (!store) throw new ForbiddenException('This review is not on your store');
    const cleaned = cleanReport(dto.reasonCode, dto.text);
    if (typeof cleaned === 'string') throw new BadRequestException(cleaned);

    // One report per review, claimed atomically.
    const claim = await this.r.ratingModel.updateOne(
      { _id: reviewId, isDelete: false, sellerReport: null },
      { $set: { sellerReport: { reportId: '', reasonCode: cleaned.code, text: cleaned.text, status: 'pending', reportedAt: new Date() } } },
    );
    if (!claim.modifiedCount) throw new ConflictException('This review was already reported');
    try {
      const report: any = await this.r.reportModel.create({
        reporterId: sellerId, reporterRole: 'seller', targetType: 'review', targetId: reviewId,
        reason: REPORT_REASONS[cleaned.code], details: cleaned.text, riskLevel: 'medium',
      });
      await this.r.ratingModel.updateOne({ _id: reviewId }, { $set: { 'sellerReport.reportId': String(report._id) } });
      this.activity?.log({
        storeId: String(review.storeId), category: 'moderation', action: 'review_reported',
        description: `Review reported: ${REPORT_REASONS[cleaned.code]}`, actorId: sellerId, actorRole: 'seller',
        targetId: reviewId, targetType: 'review',
      } as any);
    } catch (err) {
      await this.r.ratingModel.updateOne({ _id: reviewId }, { $set: { sellerReport: null } });
      throw err;
    }
    return { success: true, message: 'Review reported. Edudeen will look at it.' };
  }

  // ── insights ──────────────────────────────────────────────────────────────
  async insights(sellerId: string, role: string, storeId: string, rangeRaw: any) {
    const store = await this.ownStore(storeId, sellerId, role);
    const days = Number(rangeRaw) === 90 ? 90 : 30;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const prevStart = new Date(start.getTime() - days * 86_400_000);
    const base = { storeId, isDelete: false, rating: { $ne: null } };
    const R = this.r.ratingModel;

    const [perProduct, trend, cur, prev, life] = await Promise.all([
      R.aggregate([
        { $match: { ...base, createdAt: { $gte: start } } },
        { $group: { _id: '$productId', avg: { $avg: '$rating' }, count: { $sum: 1 }, low: { $sum: { $cond: [{ $lte: ['$rating', 2] }, 1, 0] } } } },
        { $match: { count: { $gte: 3 } } },
        { $sort: { avg: 1, count: -1 } }, { $limit: 50 },
      ]),
      R.aggregate([
        { $match: { ...base, createdAt: { $gte: start } } },
        { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'week', startOfWeek: 'monday', timezone: 'Asia/Karachi' } }, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      R.aggregate([{ $match: { ...base, createdAt: { $gte: start } } }, { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]),
      R.aggregate([{ $match: { ...base, createdAt: { $gte: prevStart, $lt: start } } }, { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]),
      R.aggregate([
        { $match: { storeId, isDelete: false } },
        { $group: {
          _id: null, total: { $sum: 1 },
          rated: { $sum: { $cond: [{ $ne: ['$rating', null] }, 1, 0] } }, sum: { $sum: { $ifNull: ['$rating', 0] } },
          replied: { $sum: { $cond: [{ $ne: ['$sellerReply', null] }, 1, 0] } },
          replyMs: { $sum: { $cond: [{ $ne: ['$sellerReply', null] }, { $subtract: ['$sellerReply.createdAt', '$createdAt'] }, 0] } },
        } },
      ]),
    ]);

    const ids = perProduct.map((p: any) => p._id).filter((id: any) => isValidObjectId(id));
    const prods: any[] = ids.length ? await this.r.productModel.find({ _id: { $in: ids } }).select('name').lean() : [];
    const nameOf = new Map(prods.map(p => [String(p._id), p.name as string]));
    const L = life[0] ?? { total: 0, rated: 0, sum: 0, replied: 0, replyMs: 0 };
    const trusted = trustedProgress({
      avgRating: L.rated ? Math.round((L.sum / L.rated) * 100) / 100 : 0,
      reviews: L.total,
      responseRatePct: L.total ? Math.round((L.replied / L.total) * 1000) / 10 : 0,
      avgReplyHours: L.replied ? Math.round((L.replyMs / L.replied / 3_600_000) * 10) / 10 : null,
    });
    const rnd = (n: number | undefined) => (n == null ? null : Math.round(n * 100) / 100);
    return {
      success: true,
      data: {
        range: days,
        enough: (cur[0]?.count ?? 0) >= 3,
        products: perProduct.map((p: any) => ({
          productId: String(p._id), title: nameOf.get(String(p._id)) ?? 'Product', avgRating: rnd(p.avg), count: p.count, lowStarCount: p.low,
        })),
        trend: trend.map((t: any) => ({ weekStart: t._id, avgRating: rnd(t.avg), count: t.count })),
        current: { avgRating: rnd(cur[0]?.avg), count: cur[0]?.count ?? 0 },
        previous: { avgRating: rnd(prev[0]?.avg), count: prev[0]?.count ?? 0 },
        trusted: { ...trusted, badgePublic: process.env.TRUSTED_SELLER_BADGE === 'true', storeName: store.name },
      },
    };
  }
}
