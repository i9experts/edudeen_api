/* eslint-disable prettier/prettier */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { recalcProductRating, recalcStoreRating } from '../rating/rating-aggregate.util';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ModerationQueryDto } from './dto/moderation-query.dto';
import { escapeRegex } from '../common/query-safety.util';
import { suspendSellerCascade } from '../common/seller-suspension.util';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

const MARKETPLACE_TARGET_TYPES = ['listing', 'seller', 'review'];

@Injectable()
export class AdminModerationService {
  private readonly logger = new Logger(AdminModerationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'moderation',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async getStats() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const baseFilter = { targetType: { $in: MARKETPLACE_TARGET_TYPES } };

    const [queueTotal, urgent, approvedToday, resolvedTodayRows] = await Promise.all([
      this.r.reportModel.countDocuments({ ...baseFilter, status: { $ne: 'resolved' } }),
      this.r.reportModel.countDocuments({ ...baseFilter, status: { $ne: 'resolved' }, riskLevel: 'high' }),
      this.r.reportModel.countDocuments({ ...baseFilter, resolution: 'approved', resolvedAt: { $gte: startOfDay } }),
      this.r.reportModel
        .find({ ...baseFilter, status: 'resolved', resolvedAt: { $gte: startOfDay } }, { createdAt: 1, resolvedAt: 1 })
        .lean<{ createdAt: Date; resolvedAt: Date }[]>(),
    ]);

    const avgReviewMinutes =
      resolvedTodayRows.length === 0
        ? 0
        : resolvedTodayRows.reduce((sum, r) => sum + (r.resolvedAt.getTime() - r.createdAt.getTime()), 0) /
          resolvedTodayRows.length /
          60000;

    return {
      success: true,
      data: {
        queueTotal,
        urgent,
        approvedToday,
        avgReviewMinutes: Math.round(avgReviewMinutes * 10) / 10,
      },
    };
  }

  private async enrich(reports: any[]) {
    const listingIds = reports.filter((r) => r.targetType === 'listing' && isValidObjectId(r.targetId)).map((r) => r.targetId);
    const sellerReportTargetIds = reports.filter((r) => r.targetType === 'seller' && isValidObjectId(r.targetId)).map((r) => r.targetId);
    const reviewIds = reports.filter((r) => r.targetType === 'review' && isValidObjectId(r.targetId)).map((r) => r.targetId);

    const [products, directSellers, reviews] = await Promise.all([
      this.r.productModel.find({ _id: { $in: listingIds } }, { name: 1, sellerId: 1 }),
      this.r.sellerModel.find({ _id: { $in: sellerReportTargetIds } }, { name: 1 }),
      reviewIds.length
        ? this.r.ratingModel.find({ _id: { $in: reviewIds } }, { rating: 1, comments: { $slice: 1 }, isDelete: 1 }).lean<any[]>()
        : Promise.resolve([] as any[]),
    ]);
    const reviewById = new Map(reviews.map((rv) => [String(rv._id), rv]));

    const productById = new Map(products.map((p) => [String(p._id), p]));
    const productSellerIds = products.map((p) => p.sellerId).filter((id) => isValidObjectId(id));
    const listingSellers = await this.r.sellerModel.find({ _id: { $in: productSellerIds } }, { name: 1 });
    const sellerNameById = new Map([...listingSellers, ...directSellers].map((s) => [String(s._id), s.name]));

    return reports.map((r) => {
      if (r.targetType === 'listing') {
        const product = productById.get(r.targetId);
        return {
          ...r,
          itemLabel: product?.name ?? 'Unknown listing',
          sellerName: product ? sellerNameById.get(product.sellerId) ?? 'Unknown' : 'Unknown',
        };
      }
      if (r.targetType === 'seller') {
        return { ...r, itemLabel: sellerNameById.get(r.targetId) ?? 'Unknown seller', sellerName: sellerNameById.get(r.targetId) ?? 'Unknown' };
      }
      const review = reviewById.get(String(r.targetId));
      if (!review) return { ...r, itemLabel: `Review ${r.targetId}`, sellerName: null };
      const text: string = review.comments?.[0]?.text ?? '';
      const stars = review.rating ? `${review.rating}★ ` : '';
      const snippet = text ? `"${text.length > 80 ? `${text.slice(0, 80)}…` : text}"` : '(no comment)';
      return { ...r, itemLabel: `${stars}review ${snippet}${review.isDelete ? ' — already removed' : ''}`, sellerName: null };
    });
  }

  async getQueue(query: ModerationQueryDto) {
    const filter: Record<string, unknown> = { targetType: { $in: MARKETPLACE_TARGET_TYPES }, status: { $ne: 'resolved' } };
    if (query.targetType) filter.targetType = query.targetType;
    if (query.riskLevel) filter.riskLevel = query.riskLevel;
    if (query.search) filter.reason = { $regex: escapeRegex(query.search), $options: 'i' };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [reports, total] = await Promise.all([
      this.r.reportModel
        .find(filter)
        .sort({ riskLevel: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.r.reportModel.countDocuments(filter),
    ]);

    const items = await this.enrich(reports);
    return { success: true, data: { items, total, page, limit } };
  }

  /** Atomically moves a not-yet-resolved report to `next`. Two admins (or a double click) cannot both act on the
   *  same report, and a resolved report can never be re-actioned. Returns the report as it was BEFORE the claim. */
  private async claimReport(id: string, next: Record<string, unknown>, from: string[]) {
    const prev = await this.r.reportModel.findOneAndUpdate(
      { _id: id, targetType: { $in: MARKETPLACE_TARGET_TYPES }, status: { $in: from } },
      { $set: next },
      { returnDocument: 'before' },
    );
    if (prev) return prev;
    const exists = await this.r.reportModel.exists({ _id: id, targetType: { $in: MARKETPLACE_TARGET_TYPES } });
    if (!exists) throw new NotFoundException('Report not found');
    throw new ConflictException('This report has already been resolved');
  }

  /** After a reported review is hidden, refresh the product/store aggregates with the same helpers the
   *  buyer/seller delete paths use. Best-effort: the review is already hidden, so a failed recompute must not
   *  roll the report back — it only leaves the cached average stale until the next review change. */
  private async recalcAfterReviewRemoval(reviewId: string) {
    try {
      const review = await this.r.ratingModel
        .findById(reviewId, { productId: 1, storeId: 1, rating: 1 })
        .lean<{ productId?: string; storeId?: string | null; rating?: number | null }>();
      if (!review || review.rating == null) return;
      if (review.productId) await recalcProductRating(this.r, review.productId);
      await recalcStoreRating(this.r, review.storeId);
    } catch (err) {
      this.logger.warn(`Rating recompute after removing review ${reviewId} failed: ${(err as Error)?.message}`);
    }
  }

  async markReviewed(id: string, meta: AuditMeta) {
    const report = await this.claimReport(id, { status: 'reviewed', reviewedBy: meta.adminId }, ['pending', 'reviewed']);
    this.log('report_reviewed', `Report ${id} (${report.targetType}) marked reviewed`, meta, id);
    return { success: true, message: 'Report marked as reviewed' };
  }

  async approve(id: string, meta: AuditMeta) {
    const report = await this.claimReport(
      id,
      { status: 'resolved', resolution: 'approved', resolvedAt: new Date(), reviewedBy: meta.adminId },
      ['pending', 'reviewed'],
    );
    this.log('report_approved', `Report ${id} (${report.targetType}) approved — no action taken on target`, meta, id);
    return { success: true, message: 'Report approved' };
  }

  async remove(id: string, meta: AuditMeta) {
    const report = await this.claimReport(
      id,
      { status: 'resolved', resolution: 'removed', resolvedAt: new Date(), reviewedBy: meta.adminId },
      ['pending', 'reviewed'],
    );

    try {
      if (!isValidObjectId(report.targetId)) throw new NotFoundException('Report target is not a valid id');
      if (report.targetType === 'listing') {
        await this.r.productModel.updateOne(
          { _id: report.targetId },
          { $set: { isDelete: true, status: 'inactive', isFeatured: false, removedByAdmin: true } },
        );
      } else if (report.targetType === 'seller') {
        // Same cascade as the Users-page suspend (stores suspended, session revoked), and safe to repeat.
        await suspendSellerCascade(this.databaseService, report.targetId);
      } else if (report.targetType === 'review') {
        // "Remove" on a review report used to resolve the report without touching the review.
        await this.r.ratingModel.updateOne({ _id: report.targetId }, { $set: { isDelete: true } });
        await this.recalcAfterReviewRemoval(report.targetId);
      }
    } catch (err) {
      // The action did not happen — put the report back so it can be retried instead of being lost as "removed".
      await this.r.reportModel.updateOne(
        { _id: id, status: 'resolved', resolution: 'removed' },
        { $set: { status: report.status, resolution: report.resolution ?? null, resolvedAt: null } },
      );
      throw err;
    }

    this.log('report_removed', `Report ${id} (${report.targetType}) actioned — target removed/suspended`, meta, id);
    return { success: true, message: 'Report actioned — target removed/suspended' };
  }
}
