/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ModerationQueryDto } from './dto/moderation-query.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

const MARKETPLACE_TARGET_TYPES = ['listing', 'seller', 'review'];

@Injectable()
export class AdminModerationService {
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
    const listingIds = reports.filter((r) => r.targetType === 'listing').map((r) => r.targetId);
    const sellerReportTargetIds = reports.filter((r) => r.targetType === 'seller').map((r) => r.targetId);

    const [products, directSellers] = await Promise.all([
      this.r.productModel.find({ _id: { $in: listingIds } }, { name: 1, sellerId: 1 }),
      this.r.sellerModel.find({ _id: { $in: sellerReportTargetIds } }, { name: 1 }),
    ]);

    const productById = new Map(products.map((p) => [String(p._id), p]));
    const productSellerIds = products.map((p) => p.sellerId);
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
      return { ...r, itemLabel: `Review ${r.targetId}`, sellerName: null };
    });
  }

  async getQueue(query: ModerationQueryDto) {
    const filter: Record<string, unknown> = { targetType: { $in: MARKETPLACE_TARGET_TYPES }, status: { $ne: 'resolved' } };
    if (query.targetType) filter.targetType = query.targetType;
    if (query.riskLevel) filter.riskLevel = query.riskLevel;
    if (query.search) filter.reason = { $regex: query.search, $options: 'i' };

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

  private async findReportOrThrow(id: string) {
    const report = await this.r.reportModel.findOne({ _id: id, targetType: { $in: MARKETPLACE_TARGET_TYPES } });
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }

  async markReviewed(id: string, meta: AuditMeta) {
    const report = await this.findReportOrThrow(id);
    await this.r.reportModel.findByIdAndUpdate(id, { $set: { status: 'reviewed', reviewedBy: meta.adminId } });
    this.log('report_reviewed', `Report ${id} (${report.targetType}) marked reviewed`, meta, id);
    return { success: true, message: 'Report marked as reviewed' };
  }

  async approve(id: string, meta: AuditMeta) {
    const report = await this.findReportOrThrow(id);
    await this.r.reportModel.findByIdAndUpdate(id, {
      $set: { status: 'resolved', resolution: 'approved', resolvedAt: new Date(), reviewedBy: meta.adminId },
    });
    this.log('report_approved', `Report ${id} (${report.targetType}) approved — no action taken on target`, meta, id);
    return { success: true, message: 'Report approved' };
  }

  async remove(id: string, meta: AuditMeta) {
    const report = await this.findReportOrThrow(id);

    if (report.targetType === 'listing') {
      await this.r.productModel.findByIdAndUpdate(report.targetId, { $set: { isDelete: true, status: 'inactive', removedByAdmin: true } });
    } else if (report.targetType === 'seller') {
      // Mirrors AdminUsersService.suspend's cascade: suspending a seller
      // here must also suspend their stores and revoke their session,
      // exactly like the Users-page suspend action does — a report-driven
      // removal shouldn't leave the seller's listings live or their
      // existing login working.
      const activeStores = await this.r.storeModel.find(
        { sellerId: report.targetId, isDelete: false, status: 'active' },
        { _id: 1 },
      );
      const storeIdsToSuspend = activeStores.map((s: any) => String(s._id));
      if (storeIdsToSuspend.length) {
        await this.r.storeModel.updateMany(
          { _id: { $in: storeIdsToSuspend } },
          { $set: { status: 'suspended' } },
        );
      }
      await this.r.sellerModel.findByIdAndUpdate(report.targetId, {
        $set: { status: 'suspended', cascadeSuspendedStoreIds: storeIdsToSuspend },
        $inc: { tokenVersion: 1 },
      });
    }

    await this.r.reportModel.findByIdAndUpdate(id, {
      $set: { status: 'resolved', resolution: 'removed', resolvedAt: new Date(), reviewedBy: meta.adminId },
    });
    this.log('report_removed', `Report ${id} (${report.targetType}) actioned — target removed/suspended`, meta, id);
    return { success: true, message: 'Report actioned — target removed/suspended' };
  }
}
