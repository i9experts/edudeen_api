/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { verifyStoreExists } from '../common/store-ownership.util';

import { clampInt } from 'src/common/query-safety.util';
export type CommissionRateSource = 'seller_override' | 'platform_plan' | 'global_default' | 'hardcoded_fallback';

export interface ResolvedCommissionRate {
  rate: number;
  source: CommissionRateSource;
}

/**
 * Admin-managed commission override layer, separate from (and layered ON TOP
 * OF) the plan-tier `PlatformPlan.limits.transactionFeeRate` mechanism that
 * `EntitlementsService` already resolves. Resolution order — see
 * `resolveRate` — lets an admin negotiate a one-off rate for a specific
 * seller, or change the platform-wide default for stores with no paid
 * platform plan yet, without touching plan documents or code constants.
 */
@Injectable()
export class CommissionRulesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get ruleModel() { return this.db.repositories.commissionRuleModel; }
  private get storeModel() { return this.db.repositories.storeModel; }

  /**
   * Resolution order:
   *   1. Active seller-specific override for this store — always wins.
   *   2. The store's own PlatformPlan tier rate, if it has an active
   *      subscription row (a store that's actually chosen/been assigned a
   *      paid tier keeps that tier's incentive rate — a global default must
   *      never quietly override it).
   *   3. Active platform-wide global default rule.
   *   4. EntitlementsService's own resolution (free-plan rate, or the
   *      hardcoded 8% last-resort constant) — used only when there is no
   *      seller override, no active plan subscription, AND no global rule.
   */
  async resolveRate(storeId: string): Promise<ResolvedCommissionRate> {
    const sellerOverride = await this.ruleModel.findOne({ scope: 'seller', storeId, isActive: true }).lean();
    if (sellerOverride) return { rate: (sellerOverride as any).rate, source: 'seller_override' };

    const activePlan = await this.entitlementsService.getActivePlanForStore(storeId);
    if (activePlan?.plan?.limits?.transactionFeeRate !== undefined) {
      return { rate: activePlan.plan.limits.transactionFeeRate, source: 'platform_plan' };
    }

    const globalDefault = await this.ruleModel.findOne({ scope: 'global', isActive: true }).lean();
    if (globalDefault) return { rate: (globalDefault as any).rate, source: 'global_default' };

    const fallbackRate = await this.entitlementsService.getTransactionFeeRate(storeId);
    return { rate: fallbackRate, source: 'hardcoded_fallback' };
  }

  // ── Global default ──────────────────────────────────────────────────────

  async getGlobalDefault() {
    return this.ruleModel.findOne({ scope: 'global', isActive: true }).lean();
  }

  async setGlobalDefault(rate: number, notes: string | undefined, adminId: string) {
    const previous = await this.ruleModel.findOne({ scope: 'global', isActive: true });
    if (previous) {
      previous.isActive = false;
      previous.supersededAt = new Date();
      await previous.save();
    }

    const rule = await this.ruleModel.create({
      scope: 'global', storeId: null, rate,
      notes: notes ?? null, createdByAdminId: adminId, isActive: true,
    });

    this.activityLogService.log({
      storeId: 'platform',
      category: 'finance',
      action: 'global_commission_rate_changed',
      description: `Global default commission rate set to ${(rate * 100).toFixed(2)}%${previous ? ` (was ${(previous.rate * 100).toFixed(2)}%)` : ''}`,
      actorId: adminId,
      actorRole: 'admin',
      targetType: 'commission_rule',
    });

    return rule;
  }

  // ── Per-seller override ─────────────────────────────────────────────────

  async getSellerOverride(storeId: string) {
    return this.ruleModel.findOne({ scope: 'seller', storeId, isActive: true }).lean();
  }

  async setSellerOverride(storeId: string, rate: number, notes: string | undefined, adminId: string) {
    await verifyStoreExists(this.storeModel, storeId);

    const previous = await this.ruleModel.findOne({ scope: 'seller', storeId, isActive: true });
    if (previous) {
      previous.isActive = false;
      previous.supersededAt = new Date();
      await previous.save();
    }

    const rule = await this.ruleModel.create({
      scope: 'seller', storeId, rate,
      notes: notes ?? null, createdByAdminId: adminId, isActive: true,
    });

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'seller_commission_override_set',
      description: `Seller commission override set to ${(rate * 100).toFixed(2)}%${previous ? ` (was ${(previous.rate * 100).toFixed(2)}%)` : ''}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: storeId,
      targetType: 'commission_rule',
    });

    return rule;
  }

  async removeSellerOverride(storeId: string, adminId: string) {
    const rule = await this.ruleModel.findOne({ scope: 'seller', storeId, isActive: true });
    if (!rule) throw new NotFoundException('No active commission override for this store');

    rule.isActive = false;
    rule.supersededAt = new Date();
    await rule.save();

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'seller_commission_override_removed',
      description: `Seller commission override removed (reverts to plan-tier/global rate)`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: storeId,
      targetType: 'commission_rule',
    });

    return { removed: true };
  }

  async listSellerOverrides(query: any) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, clampInt(query.limit, 20, 1, 100));
    const skip = (page - 1) * limit;

    const filter = { scope: 'seller' as const, isActive: true };
    const [rules, total] = await Promise.all([
      this.ruleModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.ruleModel.countDocuments(filter),
    ]);

    const storeIds = (rules as any[]).map((r) => r.storeId);
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name sellerId').lean();
    const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

    return {
      rules: (rules as any[]).map((r) => ({
        ...r,
        storeName: storeMap.get(r.storeId)?.name ?? 'Unknown store',
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    };
  }

  /** History of every rate change for a store (or 'platform' for global-default history). */
  async getHistory(scope: 'global' | 'seller', storeId: string | null) {
    if (scope === 'seller' && !storeId) throw new BadRequestException('storeId is required for seller-scope history');
    const filter: any = scope === 'global' ? { scope: 'global' } : { scope: 'seller', storeId };
    return this.ruleModel.find(filter).sort({ createdAt: -1 }).lean();
  }
}
