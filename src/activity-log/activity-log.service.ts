/* eslint-disable prettier/prettier */
import { csvLine, escapeRegex, searchTerm, plainString, parseDateParam } from 'src/common/query-safety.util';
import { clampInt } from 'src/products/product-public-view.util';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogCategory } from './schemas/activity-log.schema';
import { ActivityLogGateway } from './activity-log.gateway';
import { currentRequestAudit } from '../common/request-audit.context';

export interface LogActivityInput {
  /** Omit for a platform-level action with no single store (e.g. admin managing a PlatformPlan) — stored as the 'platform' sentinel. */
  storeId?: string;
  category: ActivityLogCategory;
  action: string;
  description?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  isSecurityAlert?: boolean;
  metadata?: object | null;
}

/** Seller-facing "Security alerts": failed logins, password/email changes, new device/IP only. */
export const SECURITY_ALERT_ACTIONS = ['login_failed', 'password_changed', 'email_changed', 'new_device_login', 'new_ip_login'];

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly gateway: ActivityLogGateway,
  ) {}

  /**
   * Never lets logging break the caller's main flow (it does not throw), but it is not silent either: the write is
   * retried once, and if it still fails the whole entry is written to the error log so it can be recovered by hand.
   * Callers that audit a sensitive action (money, rights, destructive admin work) should `await` it so the entry is
   * stored before the response goes out; everything else may leave it un-awaited. Resolves `true` when stored.
   */
  async log(data: LogActivityInput): Promise<boolean> {
    const doc = {
      storeId: data.storeId ?? 'platform',
      actorId: data.actorId ?? null,
      actorName: data.actorName ?? null,
      actorRole: data.actorRole ?? null,
      category: data.category,
      action: data.action,
      description: data.description ?? null,
      targetId: data.targetId ?? null,
      targetType: data.targetType ?? null,
      // Callers that have the request pass ip/userAgent; everyone else gets them from the request context.
      ip: data.ip ?? currentRequestAudit()?.ip ?? null,
      userAgent: data.userAgent ?? currentRequestAudit()?.userAgent ?? null,
      isSecurityAlert: data.isSecurityAlert ?? false,
      metadata: data.metadata ?? null,
    };
    let entry: any = null;
    let lastErr: any;
    for (let attempt = 0; attempt < 2 && !entry; attempt++) {
      try {
        entry = await this.databaseService.repositories.activityLogModel.create(doc);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!entry) {
      this.logger.error(`AUDIT ENTRY LOST (${doc.category}/${doc.action}): ${lastErr?.message} :: ${JSON.stringify(doc)}`);
      return false;
    }
    try {
      this.gateway.emitNewActivity(doc.storeId, entry.toObject());
    } catch (err) {
      this.logger.warn(`Activity log stored but live emit failed (${doc.category}/${doc.action}): ${err?.message}`);
    }
    return true;
  }

  /** Chronological audit trail for one entity (e.g. a StoreBanner or PromotionRequest) — no separate timeline schema, this just reads ActivityLog. */
  async getTimeline(targetId: string) {
    const logs = await this.databaseService.repositories.activityLogModel
      .find({ targetId })
      .sort({ createdAt: 1 })
      .lean();
    return { success: true, data: logs };
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  async findAll(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = clampInt(query.page, 1, 1, 10_000);
    const limit = clampInt(query.limit, 20, 1, 100);
    const skip = (page - 1) * limit;

    const filter: any = { storeId };
    if (plainString(query.category)) filter.category = query.category;
    if (plainString(query.actorId)) filter.actorId = query.actorId;
    if (plainString(query.action)) filter.action = query.action;
    const term = searchTerm(query.search);
    if (term) {
      // Escaped + bounded: the raw value was a regex ("(a+)+$" pins Mongo's CPU) and could be an operator object.
      const rx = { $regex: escapeRegex(term), $options: 'i' };
      filter.$or = [{ action: rx }, { description: rx }, { actorName: rx }];
    }
    const fromDate = parseDateParam(query.from, 'from');
    const toDate = parseDateParam(query.to, 'to');
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = fromDate;
      if (toDate) {
        const t = new Date(toDate);
        t.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = t;
      }
    }

    const { activityLogModel } = this.databaseService.repositories;
    const total = await activityLogModel.countDocuments(filter);
    const logs = await activityLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        logs,
      },
    };
  }

  async getStats(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const { activityLogModel } = this.databaseService.repositories;

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalEvents, staffActionsToday, activeStaffToday, securityAlerts, lastLogin] = await Promise.all([
      activityLogModel.countDocuments({ storeId, createdAt: { $gte: ninetyDaysAgo } }),
      activityLogModel.countDocuments({ storeId, createdAt: { $gte: startOfToday } }),
      activityLogModel.distinct('actorId', { storeId, createdAt: { $gte: startOfToday }, actorId: { $ne: null } }),
      activityLogModel.countDocuments({ storeId, isSecurityAlert: true, category: 'security', action: { $in: SECURITY_ALERT_ACTIONS }, createdAt: { $gte: ninetyDaysAgo } }),
      activityLogModel
        .findOne({ storeId, category: 'security', action: 'login_success' })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    return {
      success: true,
      data: {
        totalEvents,
        staffActionsToday,
        activeStaffToday: activeStaffToday.length,
        securityAlerts,
        lastLogin: lastLogin
          ? { at: (lastLogin as any).createdAt, actorName: (lastLogin as any).actorName, ip: (lastLogin as any).ip, userAgent: (lastLogin as any).userAgent }
          : null,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — platform-wide (unscoped by storeId) equivalents. Every
  // financially-sensitive admin action across this codebase (commission-rate
  // changes, payout approve/reject/retry, manual-payment approve/reject,
  // payout-method verification) already writes here via `log()` — this is
  // simply the first read-side surface an admin can use to actually see
  // that audit trail platform-wide, rather than only per-store as a seller.
  // ═══════════════════════════════════════════════════════════════════════

  private buildAdminFilter(query: any): Record<string, any> {
    const filter: Record<string, any> = {};
    for (const key of ['storeId', 'category', 'actorId', 'actorRole', 'action', 'targetType'] as const) {
      const v = plainString(query[key]);
      if (v) filter[key] = v;
    }
    if (query.isSecurityAlert !== undefined) {
      filter.isSecurityAlert = query.isSecurityAlert === 'true' || query.isSecurityAlert === true;
      if (filter.isSecurityAlert && !filter.storeId) filter.action = { $ne: 'login_success' };
      else if (filter.isSecurityAlert) { filter.category = 'security'; filter.action = { $in: SECURITY_ALERT_ACTIONS }; }
    }
    const term = searchTerm(query.search);
    if (term) {
      const rx = { $regex: escapeRegex(term), $options: 'i' };
      filter.$or = [{ action: rx }, { description: rx }, { actorName: rx }];
    }
    const fromDate = parseDateParam(query.from, 'from');
    const toDate = parseDateParam(query.to, 'to');
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = fromDate;
      if (toDate) {
        const t = new Date(toDate);
        t.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = t;
      }
    }
    return filter;
  }

  async adminFindAll(query: any) {
    const page = clampInt(query.page, 1, 1, 10_000);
    const limit = clampInt(query.limit, 50, 1, 200);
    const skip = (page - 1) * limit;

    const { activityLogModel } = this.databaseService.repositories;
    const filter = this.buildAdminFilter(query);

    const [total, logs] = await Promise.all([
      activityLogModel.countDocuments(filter),
      activityLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        logs,
      },
    };
  }

  async adminExportCsv(query: any): Promise<string> {
    const { activityLogModel } = this.databaseService.repositories;
    const filter = this.buildAdminFilter(query);
    const logs = await activityLogModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const header = ['Date', 'Store', 'Category', 'Action', 'Actor', 'Role', 'Description', 'Security Alert', 'IP'];
    const rows = logs.map((l: any) => [
      new Date(l.createdAt).toISOString(),
      l.storeId,
      l.category,
      l.action,
      l.actorName ?? l.actorId ?? '',
      l.actorRole ?? '',
      l.description ?? '',
      l.isSecurityAlert ? 'yes' : 'no',
      l.ip ?? '',
    ]);

    // csvLine neutralises spreadsheet formulas (= + - @) — actor names and descriptions are user-influenced.
    return [header, ...rows].map((r) => csvLine(r)).join('\n');
  }

  async exportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(storeId, sellerId);

    const { activityLogModel } = this.databaseService.repositories;

    const filter: any = { storeId };
    if (plainString(query.category)) filter.category = query.category;
    const exportFrom = parseDateParam(query.from, 'from');
    const exportTo = parseDateParam(query.to, 'to');
    if (exportFrom || exportTo) {
      filter.createdAt = {};
      if (exportFrom) filter.createdAt.$gte = exportFrom;
      if (exportTo) filter.createdAt.$lte = exportTo;
    }

    const logs = await activityLogModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const header = ['Date', 'Category', 'Action', 'Actor', 'Role', 'Description', 'IP'];
    const rows = logs.map((l: any) => [
      new Date(l.createdAt).toISOString(),
      l.category,
      l.action,
      l.actorName ?? l.actorId ?? '',
      l.actorRole ?? '',
      l.description ?? '',
      l.ip ?? '',
    ]);

    return [header, ...rows].map((r) => csvLine(r)).join('\n');
  }
}
