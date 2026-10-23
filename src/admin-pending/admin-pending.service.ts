/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';

export interface PendingCounts { payouts: number; paymentProofs: number; listings: number; refunds: number; promotions: number }
/** Which right a staff member needs to see each queue's number (the owner sees all). */
export const PENDING_PERMISSION: Record<keyof PendingCounts, string> = {
  payouts: 'finance.payouts',
  paymentProofs: 'payments.view',
  listings: 'marketplace.view',
  refunds: 'orders.view',
  promotions: 'marketing.view',
};

const CACHE_KEY = 'admin:pending-counts:v1';
const TTL_SECONDS = 45;

@Injectable()
export class AdminPendingService {
  private readonly logger = new Logger(AdminPendingService.name);
  private mem: { at: number; v: PendingCounts } | null = null;

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService) {}

  private async compute(): Promise<PendingCounts> {
    const r = this.db.repositories;
    const [payouts, paymentProofs, listings, refunds, promotions] = await Promise.all([
      r.payoutModel.countDocuments({ status: 'pending' }),
      r.manualPaymentProofModel.countDocuments({ status: 'pending' }),
      r.productModel.countDocuments({ isDelete: false, status: 'pending_review' }),
      r.refundRequestModel.countDocuments({ status: 'pending' }),
      // Awaiting the admin's decision: submitted (and paid for) but not yet approved.
      r.promotionRequestModel.countDocuments({ status: 'pending' }),
    ]);
    return { payouts, paymentProofs, listings, refunds, promotions };
  }

  /** Cached 45 s (Redis, with an in-process fallback), so a sidebar polling every minute is one cheap read. */
  async counts(): Promise<PendingCounts> {
    try {
      const hit = await this.redis.get(CACHE_KEY);
      if (hit) return JSON.parse(hit) as PendingCounts;
    } catch { /* fall through to memory */ }
    if (this.mem && Date.now() - this.mem.at < TTL_SECONDS * 1000) return this.mem.v;
    const v = await this.compute();
    this.mem = { at: Date.now(), v };
    try { await this.redis.set(CACHE_KEY, JSON.stringify(v), TTL_SECONDS); } catch (e: any) { this.logger.warn(`pending-counts cache write failed: ${e?.message}`); }
    return v;
  }

  /** Counts the caller may see. `permissions` undefined = owner (everything). */
  async forPermissions(permissions?: Set<string> | null) {
    const all = await this.counts();
    const out: Partial<PendingCounts> = {};
    (Object.keys(all) as (keyof PendingCounts)[]).forEach((k) => {
      if (!permissions || permissions.has(PENDING_PERMISSION[k])) out[k] = all[k];
    });
    const total = Object.values(out).reduce((n, v) => n + (v ?? 0), 0);
    return { ...out, total };
  }
}
