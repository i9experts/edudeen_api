/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ClientSession } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { AddPayoutMethodDto } from './dto/add-payout-method.dto';
import { UpdatePayoutScheduleDto } from './dto/update-payout-schedule.dto';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { round } from 'src/common/number.util';
import { verifyStoreExists, verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { CommissionRulesService } from 'src/commission-rules/commission-rules.service';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';

import { clampInt } from 'src/common/query-safety.util';
// ── Platform fee constants ───────────────────────────────────────────────────
export const PLATFORM_FEE_RATE       = 0.08;   // 8% per sale — last-resort fallback, see CommissionRulesService
export const PAYMENT_PROCESSING_RATE = 0.029;  // 2.9%
export const PAYMENT_PROCESSING_FIXED = 0.30;  // $0.30 per transaction
export const CLEARING_DAYS           = 3;      // default — non-card rails (manual bank transfer, COD)
// Card-funded (Stripe) sales carry real chargeback exposure that can
// surface weeks after the charge — a Pakistani bank-transfer payment has no
// equivalent reversal mechanism once sent. Holding card-funded proceeds
// longer before they become payout-eligible is the direct mitigation for
// "chargeback arrives after the seller has already been paid out".
export const CLEARING_DAYS_CARD      = 14;
/** True when the buyer paid CASH to the seller's own courier (Cash on Delivery
 *  in 'seller' fulfillment — every store unless it opted into platform
 *  fulfillment). The platform never receives that money, so the seller's ledger
 *  must be DEBITED the commission, never credited the sale (see
 *  `recordSale`). A missing `fulfillmentMode` means 'seller' (all pre-existing
 *  orders). */
export function isSellerCollectedCod(paymentType: string | null | undefined, sellerOrder: { fulfillmentMode?: string | null } | null | undefined): boolean {
  return paymentType === 'cash_on_delivery' && sellerOrder?.fulfillmentMode !== 'platform';
}

/** The shipping line a store is credited for a sub-order, in the seller's settlement currency.
 *  Only a store that ships its own physical orders ('seller' fulfillment) is paid for shipping, and only
 *  when the platform collected that money (card / bank transfer): on COD the seller's courier collects
 *  the shipping cash along with the sale, and when the platform ships ('platform') it keeps the fee. */
export function shippingCreditFor(
  order: { paymentType?: string | null },
  sellerOrder: { fulfillmentType?: string | null; fulfillmentMode?: string | null; settlementShippingFee?: number | null },
): number {
  if (sellerOrder.fulfillmentType !== 'physical') return 0;
  if (sellerOrder.fulfillmentMode === 'platform') return 0;
  if (order.paymentType === 'cash_on_delivery') return 0;
  return sellerOrder.settlementShippingFee ?? 0;
}

function clearingDaysForRail(paymentMethodType: string): number {
  return paymentMethodType === 'stripe' ? CLEARING_DAYS_CARD : CLEARING_DAYS;
}
const ESTIMATED_TAX_RATE      = 0.15;   // 15% estimate shown in UI

/** Currency-aware amount formatting for CSV export — every other currency-agnostic $-literal in this file was a latent multi-currency bug waiting to happen; this is the one shared spot so it can't drift per call site. */
function amountFmt(n: number, currency: string): string {
  return currency === 'PKR' ? `PKR ${n.toFixed(2)}` : `$${n.toFixed(2)}`;
}

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly commissionRulesService: CommissionRulesService,
    private readonly adminConfigService: AdminConfigService,
    private readonly notificationsService: NotificationsService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ── Shorthand repo getters ───────────────────────────────────────────────

  private get balanceModel()   { return this.db.repositories.sellerBalanceModel; }
  private get txModel()        { return this.db.repositories.transactionModel; }
  private get payoutModel()    { return this.db.repositories.payoutModel; }
  private get methodModel()    { return this.db.repositories.payoutMethodModel; }
  private get scheduleModel()  { return this.db.repositories.payoutScheduleModel; }
  private get taxModel()       { return this.db.repositories.taxReportModel; }
  private get storeModel()     { return this.db.repositories.storeModel; }
  private get sellerModel()    { return this.db.repositories.sellerModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private round(n: number) { return round(n); }

  /**
   * Every multi-document ledger mutation (balance + transaction rows, or
   * balance + payout + transaction rows) runs inside a real Mongo session
   * transaction — a crash or error partway through rolls the whole write
   * back instead of leaving a balance updated with no matching ledger entry
   * (or vice versa). MongoDB Atlas is always a replica set, so transactions
   * are available in every environment this API runs in.
   */
  private async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(fn);
  }

  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    return verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
  }

  /** Admin-facing equivalent — admins may act on any store, so this only checks the store exists (not who owns it). */
  private async verifyStoreExistsForAdmin(storeId: string) {
    return verifyStoreExists(this.storeModel, storeId);
  }

  /**
   * A store can hold a balance in more than one currency — e.g. USD from
   * Stripe sales and PKR from Pakistan manual-transfer sales — cleared and
   * paid out independently (see SellerBalance.currency). Defaults to 'USD'
   * so every pre-existing caller (all of which predate multi-currency
   * support) keeps behaving exactly as before.
   */
  async getOrCreateBalance(storeId: string, sellerId: string, currency = 'USD', session?: ClientSession) {
    let balance = await this.balanceModel.findOne({ storeId, currency }, null, { session });
    if (!balance) {
      balance = new this.balanceModel({ storeId, sellerId, currency });
      await balance.save({ session });
    }
    return balance;
  }

  private async getOrCreateSchedule(storeId: string, sellerId: string, currency = 'USD') {
    let schedule = await this.scheduleModel.findOne({ storeId, currency });
    if (!schedule) {
      // Compute next Monday as default nextPayoutAt
      const nextMonday = new Date();
      nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
      nextMonday.setHours(9, 0, 0, 0);
      schedule = await this.scheduleModel.create({ storeId, sellerId, currency, nextPayoutAt: nextMonday });
    }
    return schedule;
  }

  /**
   * Flags (or clears the flag on) a seller balance that's gone negative —
   * typically because a refund/chargeback reversal exceeded what was still
   * held after the seller already withdrew it (see Module 5 of the payout
   * spec: "do not silently fail or ignore this case"). The negative balance
   * itself is the debt — future sales naturally pay it down as
   * `pendingBalance`/`availableBalance` climb back toward zero; this just
   * makes the situation visible to admins (`isFlaggedForReview`) instead of
   * it being a number buried in a list. Mutates `balance` in place; caller
   * is responsible for saving it.
   */
  private reevaluateDebtFlag(balance: any, reason?: string): { justFlagged: boolean; justCleared: boolean } {
    const isNegative = balance.availableBalance < 0 || balance.pendingBalance < 0;
    const wasFlagged = balance.isFlaggedForReview;

    if (isNegative && !wasFlagged) {
      balance.isFlaggedForReview = true;
      balance.flaggedReason = reason ?? 'Available or pending balance went negative';
      balance.flaggedAt = new Date();
      return { justFlagged: true, justCleared: false };
    }
    if (!isNegative && wasFlagged) {
      balance.isFlaggedForReview = false;
      balance.flaggedReason = null;
      balance.flaggedAt = null;
      return { justFlagged: false, justCleared: true };
    }
    return { justFlagged: false, justCleared: false };
  }

  /**
   * Aggregate revenue and fee totals for a date range, scoped to ONE
   * currency — summing USD and PKR transaction amounts together would
   * produce a meaningless number, so every caller must resolve which
   * currency's stats it wants (see `getDashboard`, which now computes this
   * once per currency the store actually holds).
   */
  private async getPeriodStats(storeId: string, from: Date, to: Date, currency: string) {
    const agg = await this.txModel.aggregate([
      { $match: { storeId, currency, status: 'completed', createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$type',
          total: { $sum: { $abs: '$amount' } },
          count: { $sum: 1 },
        },
      },
    ]);
    const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0 };
    for (const row of agg) stats[row._id] = this.round(row.total);
    return stats;
  }

  /** Compute next scheduled payout date from current schedule */
  private computeNextPayoutDate(schedule: any): Date | null {
    const now = new Date();
    const next = new Date(now);

    if (schedule.frequency === 'weekly') {
      const target = schedule.dayOfWeek;
      const diff = (target + 7 - now.getDay()) % 7 || 7;
      next.setDate(now.getDate() + diff);
    } else if (schedule.frequency === 'biweekly') {
      next.setDate(now.getDate() + 14);
    } else if (schedule.frequency === 'monthly') {
      next.setMonth(now.getMonth() + 1);
      next.setDate(Math.min(schedule.dayOfMonth, 28));
    } else if (schedule.frequency === 'daily') {
      next.setDate(now.getDate() + 1);
    } else {
      return null;
    }
    next.setHours(9, 0, 0, 0);
    return next;
  }

  /** Get quarterly date range for a given year and period */
  private getPeriodDateRange(year: number, period: string): { from: Date; to: Date } {
    const ranges: Record<string, [number, number, number, number]> = {
      q1: [0, 1, 2, 31],
      q2: [3, 4, 5, 30],
      q3: [6, 7, 8, 30],
      q4: [9, 10, 11, 31],
    };
    if (period === 'annual') {
      return { from: new Date(year, 0, 1), to: new Date(year, 11, 31, 23, 59, 59) };
    }
    const [startMonth, , endMonth, endDay] = ranges[period];
    return {
      from: new Date(year, startMonth, 1),
      to: new Date(year, endMonth, endDay, 23, 59, 59),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Multi-currency wallet dashboard — a store can hold entirely separate
   * balances (USD from Stripe sales, PKR from Pakistan manual-transfer
   * sales), each with its own schedule/default-method/pending-payout, so
   * this returns one `wallets[]` entry per currency the store actually has
   * a balance or schedule document in (defaulting to just `['USD']` for a
   * brand-new store with neither yet) instead of a single flat balance —
   * a PKR-earning seller must never see "$0 available" just because their
   * balance happens to live in a different currency document.
   */
  async getDashboard(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [rawBalances, rawSchedules, rawMethods, rawPendingPayouts, commissionRate] = await Promise.all([
      this.balanceModel.find({ storeId }).lean(),
      this.scheduleModel.find({ storeId }).lean(),
      this.methodModel.find({ storeId }).lean(),
      this.payoutModel.find({ storeId, status: { $in: ['pending', 'processing'] } }).sort({ createdAt: -1 }).lean(),
      this.commissionRulesService.resolveRate(storeId),
    ]);

    // `.lean()` bypasses Mongoose schema defaults, so a document saved before
    // `currency` existed on these schemas comes back with the field entirely
    // absent rather than defaulted to 'USD' — left alone that creates a
    // phantom extra "currency" bucket below. Normalize once, here, so this
    // can never happen again regardless of what's actually stored.
    const balances = (rawBalances as any[]).map((b) => ({ ...b, currency: b.currency || 'USD' }));
    const schedules = (rawSchedules as any[]).map((s) => ({ ...s, currency: s.currency || 'USD' }));
    const methods = (rawMethods as any[]).map((m) => ({ ...m, currency: m.currency || 'USD' }));
    const pendingPayouts = (rawPendingPayouts as any[]).map((p) => ({ ...p, currency: p.currency || 'USD' }));

    const currencies = [...new Set([
      ...(balances as any[]).map((b) => b.currency),
      ...(schedules as any[]).map((s) => s.currency),
    ])];
    if (currencies.length === 0) currencies.push('USD');

    const wallets = await Promise.all(currencies.map(async (currency) => {
      const balance = (balances as any[]).find((b) => b.currency === currency) ?? {
        availableBalance: 0, pendingBalance: 0, totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0,
        isFlaggedForReview: false, flaggedReason: null,
      };
      const schedule = (schedules as any[]).find((s) => s.currency === currency) ?? {
        frequency: 'weekly', isEnabled: true, minimumAmount: currency === 'PKR' ? 1500 : 5, nextPayoutAt: null,
      };
      const defaultMethod = (methods as any[]).find((m) => m.currency === currency && m.isDefault) ?? null;
      const pendingPayout = (pendingPayouts as any[]).find((p) => p.currency === currency) ?? null;

      const [thisMonth, lastMonth] = await Promise.all([
        this.getPeriodStats(storeId, thisMonthStart, now, currency),
        this.getPeriodStats(storeId, lastMonthStart, lastMonthEnd, currency),
      ]);
      const revenueGrowth = lastMonth.sale > 0
        ? this.round(((thisMonth.sale - lastMonth.sale) / lastMonth.sale) * 100)
        : 0;

      return {
        currency,
        availableBalance: balance.availableBalance,
        pendingBalance: balance.pendingBalance,
        isFlaggedForReview: balance.isFlaggedForReview ?? false,
        flaggedReason: balance.flaggedReason ?? null,
        nextPayout: {
          pendingAmount: pendingPayout?.amount ?? null,
          scheduledAt: schedule.nextPayoutAt,
          method: defaultMethod
            ? { type: defaultMethod.type, bankName: defaultMethod.bankName, last4: defaultMethod.accountLast4 }
            : null,
        },
        summary: {
          thisMonthRevenue: thisMonth.sale,
          revenueGrowthPercent: revenueGrowth,
          platformFees: thisMonth.fee,
          totalPaidOut: balance.totalPayouts,
          pendingTax: this.round(thisMonth.sale * ESTIMATED_TAX_RATE),
        },
        payoutSchedule: {
          frequency: schedule.frequency,
          isEnabled: schedule.isEnabled,
          minimumAmount: schedule.minimumAmount,
          nextPayoutAt: schedule.nextPayoutAt,
        },
      };
    }));

    return {
      wallets,
      feeBreakdown: {
        marketplaceListingFee: 'Free',
        transactionFee: `${(commissionRate.rate * 100).toFixed(2)}% per sale`,
        transactionFeeSource: commissionRate.source,
        paymentProcessing: `${PAYMENT_PROCESSING_RATE * 100}% + $${PAYMENT_PROCESSING_FIXED} (card payments only — not charged for COD or bank transfer)`,
        digitalDelivery: 'Included',
        aiCredits: '750 / month',
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Shared filter builder — used by the seller's own transaction list/export and by the admin platform-wide equivalents. */
  private buildTransactionFilter(query: any, extra?: Record<string, any>): Record<string, any> {
    const filter: Record<string, any> = { ...extra };
    if (query.type)    filter.type   = query.type;
    if (query.status)  filter.status = query.status;
    if (query.storeId) filter.storeId = query.storeId;
    if (query.sellerId) filter.sellerId = query.sellerId;
    if (query.currency) filter.currency = query.currency;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to)   filter.createdAt.$lte = new Date(query.to);
    }
    return filter;
  }

  /** Shared paginated transaction query — used by both the seller and admin transaction-list endpoints. */
  private async queryTransactions(filter: Record<string, any>, query: any, maxLimit = 100) {
    const page  = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(maxLimit, clampInt(query.limit, 20, 1, 100));
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      this.txModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.txModel.countDocuments(filter),
    ]);

    return { transactions, total, page, limit, pages: Math.ceil(total / limit) };
  }

  private transactionsToCsv(txs: any[]): string {
    const header = 'Date,Store,Description,Type,Currency,Amount,Balance After,Status\n';
    const rows = txs.map((t: any) => {
      const date = new Date(t.createdAt).toISOString().split('T')[0];
      const currency = t.currency || 'USD';
      const amount = t.amount >= 0 ? `+${amountFmt(t.amount, currency)}` : `-${amountFmt(Math.abs(t.amount), currency)}`;
      return `"${date}","${t.storeId}","${t.description}","${t.type}","${currency}","${amount}","${amountFmt(t.balanceAfter, currency)}","${t.status}"`;
    }).join('\n');
    return header + rows;
  }

  async getTransactions(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const filter = this.buildTransactionFilter(query, { storeId });
    return this.queryTransactions(filter, query);
  }

  async exportTransactionsCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(sellerId, storeId);
    const filter = this.buildTransactionFilter(query, { storeId });
    const txs = await this.txModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return this.transactionsToCsv(txs);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Core debit + payout-record + ledger-entry write shared by the seller's
   * on-demand "Withdraw" (`requestPayout`) and the scheduled auto-payout
   * batch (`processScheduledPayouts`) — both are the same money movement,
   * differing only in who/what triggered it (`source`) and where the amount
   * came from. Caller must already be inside `withTransaction`.
   */
  private async debitAndCreatePayout(
    session: ClientSession,
    storeId: string, sellerId: string, currency: string, amount: number,
    method: any, notes: string | null, source: 'seller_manual' | 'scheduled_auto',
  ) {
    const balance = await this.getOrCreateBalance(storeId, sellerId, currency, session);
    if (amount > balance.availableBalance) {
      throw new BadRequestException(`Insufficient balance — available: ${currency} ${balance.availableBalance.toFixed(2)}`);
    }

    const balanceBefore = balance.availableBalance;
    balance.availableBalance = this.round(balance.availableBalance - amount);
    balance.totalPayouts = this.round(balance.totalPayouts + amount);
    await balance.save({ session });

    const payout = new this.payoutModel({
      storeId,
      sellerId,
      amount,
      currency,
      payoutMethodId: method._id?.toString?.() ?? method.payoutMethodId,
      payoutMethodSnapshot: {
        type: method.type,
        bankName: method.bankName,
        accountLast4: method.accountLast4 ?? undefined,
      },
      notes: notes || null,
      status: 'processing',
      source,
    });
    await payout.save({ session });

    const tx = new this.txModel({
      storeId,
      sellerId,
      currency,
      type: 'payout',
      amount: -amount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Payout — ${method.bankName || method.type} ••${method.accountLast4 || ''}`,
      referenceId: (payout as any)._id.toString(),
      referenceType: 'payout',
      status: 'completed',
    });
    await tx.save({ session });

    return payout;
  }

  /** Money amounts must be finite and have at most 2 decimals; anything else
   *  (10.005, 0.1+0.2 artefacts) would let the ledger and the payout row drift. */
  private normalizeAmount(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) throw new BadRequestException('Amount must be a positive number');
    if (Math.abs(raw * 100 - Math.round(raw * 100)) > 1e-6) {
      throw new BadRequestException('Amount can have at most 2 decimal places');
    }
    return this.round(raw);
  }

  async requestPayout(sellerId: string, storeId: string, dto: RequestPayoutDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const amount = this.normalizeAmount(dto.amount);

    const method = await this.methodModel.findById(dto.payoutMethodId);
    if (!method || method.storeId !== storeId) throw new NotFoundException('Payout method not found');
    if (method.status !== 'active') {
      throw new BadRequestException(
        method.status === 'pending_verification'
          ? 'This payout method is still awaiting admin verification'
          : 'Payout method is not active',
      );
    }

    const currency = method.currency || 'USD';
    const minimum = await this.adminConfigService.getPayoutMinimum(currency);
    if (amount < minimum) {
      throw new BadRequestException(`Minimum payout amount is ${currency} ${minimum.toFixed(2)}`);
    }

    return this.withTransaction((session) =>
      this.debitAndCreatePayout(session, storeId, sellerId, currency, amount, method, dto.notes ?? null, 'seller_manual'),
    );
  }

  /**
   * Weekly (configurable per-schedule via `frequency`/`dayOfWeek`/`dayOfMonth`)
   * auto-payout batch — invoked daily by SchedulerService so each schedule's
   * OWN `nextPayoutAt` (not the cron's cadence) decides when it's actually
   * due. For every due, enabled schedule: sweeps the store's full available
   * balance into a new payout request (same 'processing' status + admin
   * queue as a seller-initiated withdrawal — see `source: 'scheduled_auto'`
   * for how they're told apart) if it's at/above the greater of the
   * schedule's own minimum and the platform-wide floor, the store has an
   * active default payout method, and it doesn't already have one in flight.
   * One schedule's failure never aborts the batch for the rest.
   */
  async processScheduledPayouts(): Promise<{ schedulesChecked: number; payoutsCreated: number; totalAmount: number; skipped: number }> {
    const now = new Date();
    const dueSchedules = await this.scheduleModel.find({
      isEnabled: true,
      frequency: { $ne: 'manual' },
      nextPayoutAt: { $lte: now },
    }).lean();

    let payoutsCreated = 0;
    let totalAmount = 0;
    let skipped = 0;

    for (const schedule of dueSchedules as any[]) {
      try {
        // Ticks the schedule forward regardless of outcome — a cycle with
        // nothing (yet) to pay out still needs its next due date advanced.
        const nextDate = this.computeNextPayoutDate(schedule);
        await this.scheduleModel.updateOne({ _id: schedule._id }, { $set: { nextPayoutAt: nextDate } });

        if (!schedule.defaultPayoutMethodId) { skipped++; continue; }

        const currency = schedule.currency || 'USD';
        const [method, balance, hasPendingPayout] = await Promise.all([
          this.methodModel.findById(schedule.defaultPayoutMethodId),
          this.getOrCreateBalance(schedule.storeId, schedule.sellerId, currency),
          this.payoutModel.exists({ storeId: schedule.storeId, currency, status: { $in: ['pending', 'processing'] } }),
        ]);

        if (!method || method.status !== 'active') { skipped++; continue; }
        if (hasPendingPayout) { skipped++; continue; }

        const platformMinimum = await this.adminConfigService.getPayoutMinimum(currency);
        const effectiveMinimum = Math.max(schedule.minimumAmount ?? 0, platformMinimum);
        if (balance.availableBalance < effectiveMinimum) { skipped++; continue; }

        const amount = balance.availableBalance;
        const payout = await this.withTransaction((session) =>
          this.debitAndCreatePayout(session, schedule.storeId, schedule.sellerId, currency, amount, method, 'Auto-generated by scheduled payout batch', 'scheduled_auto'),
        );

        payoutsCreated++;
        totalAmount = this.round(totalAmount + amount);

        this.notificationsService.notify({
          recipientId: schedule.sellerId,
          recipientRole: 'seller',
          type: NOTIFICATION_TYPES.PAYOUT_AUTO_INITIATED,
          title: 'Payout initiated',
          body: `We've automatically initiated a ${currency} ${amount.toFixed(2)} payout to your ${method.bankName || method.type} account, per your payout schedule.`,
          data: { payoutId: (payout as any)._id.toString(), storeId: schedule.storeId },
        }).catch(() => {});
      } catch (err: any) {
        skipped++;
        console.error(`Scheduled payout failed for store ${schedule.storeId}:`, err?.message);
      }
    }

    return { schedulesChecked: dueSchedules.length, payoutsCreated, totalAmount, skipped };
  }

  async getPayouts(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const page  = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(50, clampInt(query.limit, 20, 1, 100));
    const skip  = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.status) filter.status = query.status;
    if (query.currency) filter.currency = query.currency;

    const [payouts, total] = await Promise.all([
      this.payoutModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.payoutModel.countDocuments(filter),
    ]);
    return { payouts, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getPayoutById(sellerId: string, storeId: string, payoutId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const payout = await this.payoutModel.findOne({ _id: payoutId, storeId });
    if (!payout) throw new NotFoundException('Payout not found');
    return payout;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private readonly PKR_METHOD_TYPES = ['jazzcash', 'easypaisa'];

  /**
   * Soft ownership-sanity check — flags (never blocks) a payout method whose
   * declared account holder doesn't reasonably match the seller's registered
   * name, so an admin can review it before the first payout goes out.
   */
  private async checkAccountTitleMismatch(sellerId: string, accountHolder?: string | null) {
    if (!accountHolder) return { flagged: false, note: null as string | null };
    const seller = await this.sellerModel.findById(sellerId).select('name').lean();
    const sellerName = (seller as any)?.name?.trim().toLowerCase();
    const holderName = accountHolder.trim().toLowerCase();
    if (!sellerName || !holderName) return { flagged: false, note: null };

    const matches = sellerName === holderName || holderName.includes(sellerName) || sellerName.includes(holderName);
    if (matches) return { flagged: false, note: null };

    return {
      flagged: true,
      note: `Account holder "${accountHolder}" does not closely match the seller's registered name "${(seller as any).name}" — flagged for admin review, not blocked.`,
    };
  }

  async addPayoutMethod(sellerId: string, storeId: string, dto: AddPayoutMethodDto) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const currency = dto.currency ?? (this.PKR_METHOD_TYPES.includes(dto.type) ? 'PKR' : 'USD');
    // "Default" is scoped per currency — a store can hold a USD wallet and a
    // PKR wallet at once, each needing its own default payout method, so
    // adding a store's first-ever PKR method (say) must not touch whichever
    // method is already the USD default.
    const isFirstForCurrency = !(await this.methodModel.exists({ storeId, currency }));
    const { flagged, note } = await this.checkAccountTitleMismatch(sellerId, dto.accountHolder);

    const method = await this.methodModel.create({
      storeId,
      sellerId,
      type: dto.type,
      currency,
      bankName: dto.bankName || null,
      accountHolder: dto.accountHolder || null,
      accountLast4: dto.accountNumber ? dto.accountNumber.slice(-4) : null,
      routingNumber: dto.routingNumber || null,
      externalAccountId: dto.externalAccountId || null,
      isDefault: dto.setAsDefault || isFirstForCurrency,
      accountTitleMismatchFlagged: flagged,
      accountTitleMismatchNote: note,
    });

    // If this is set as default, unset only the other methods IN THE SAME CURRENCY.
    if (method.isDefault) {
      await this.methodModel.updateMany(
        { storeId, currency, _id: { $ne: method._id } },
        { $set: { isDefault: false } },
      );
    }

    return method;
  }

  /** Admin-only — moves a payout method to 'active' (or back to 'inactive') after reviewing it. No live automated verification exists yet, so every new method starts 'pending_verification' and must pass through here before a seller can withdraw to it. */
  async adminVerifyPayoutMethod(storeId: string, methodId: string, adminId: string, approve: boolean, note?: string) {
    await this.verifyStoreExistsForAdmin(storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');

    method.status = approve ? 'active' : 'inactive';
    method.verifiedByAdminId = adminId;
    method.verifiedAt = new Date();
    if (note) method.accountTitleMismatchNote = note;
    await method.save();

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: approve ? 'payout_method_verified' : 'payout_method_rejected',
      description: `Payout method (${method.type}) ${approve ? 'verified and activated' : 'rejected'} by admin`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: methodId,
      targetType: 'payout_method',
    });

    return method;
  }

  async getPayoutMethods(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    return this.methodModel.find({ storeId }).sort({ isDefault: -1, createdAt: -1 }).lean();
  }

  async updatePayoutMethod(sellerId: string, storeId: string, methodId: string, dto: AddPayoutMethodDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');

    // Any change to the actual destination invalidates a prior admin
    // verification — otherwise a seller could get a method verified once,
    // then quietly swap in a different account/routing number afterwards.
    const destinationChanged =
      (dto.bankName !== undefined && dto.bankName !== method.bankName) ||
      (!!dto.accountNumber && dto.accountNumber.slice(-4) !== method.accountLast4) ||
      (dto.routingNumber !== undefined && dto.routingNumber !== method.routingNumber) ||
      (dto.externalAccountId !== undefined && dto.externalAccountId !== method.externalAccountId) ||
      // Currency decides WHICH wallet this method pays out of — flipping it on an
      // already-verified method must send it back to review. (accountHolder alone
      // is deliberately not a destination change; checkAccountTitleMismatch covers it.)
      (dto.currency !== undefined && dto.currency !== method.currency);

    if (dto.bankName !== undefined)    method.bankName    = dto.bankName;
    if (dto.accountHolder !== undefined) method.accountHolder = dto.accountHolder;
    if (dto.accountNumber)             method.accountLast4 = dto.accountNumber.slice(-4);
    if (dto.routingNumber !== undefined) method.routingNumber = dto.routingNumber;
    if (dto.externalAccountId !== undefined) method.externalAccountId = dto.externalAccountId;
    if (dto.currency !== undefined)    method.currency = dto.currency;

    if (destinationChanged && method.status !== 'pending_verification') {
      method.status = 'pending_verification';
      method.verifiedByAdminId = null;
      method.verifiedAt = null;
    }

    if (dto.accountHolder !== undefined) {
      const { flagged, note } = await this.checkAccountTitleMismatch(sellerId, dto.accountHolder);
      method.accountTitleMismatchFlagged = flagged;
      method.accountTitleMismatchNote = note;
    }

    await method.save();
    return method;
  }

  async deletePayoutMethod(sellerId: string, storeId: string, methodId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');
    if (method.isDefault) throw new BadRequestException('Cannot delete the default payout method — set another as default first');
    await method.deleteOne();
    return { deleted: true };
  }

  async setDefaultPayoutMethod(sellerId: string, storeId: string, methodId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');

    // Scoped to this method's own currency — setting a PKR method as default
    // must not clear the store's separate USD default.
    await this.methodModel.updateMany({ storeId, currency: method.currency }, { $set: { isDefault: false } });
    method.isDefault = true;
    await method.save();
    return { isDefault: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT SCHEDULE
  // ═══════════════════════════════════════════════════════════════════════════

  async getPayoutSchedule(sellerId: string, storeId: string, currency = 'USD') {
    await this.verifyStoreOwnership(sellerId, storeId);
    return this.getOrCreateSchedule(storeId, sellerId, currency);
  }

  async updatePayoutSchedule(sellerId: string, storeId: string, dto: UpdatePayoutScheduleDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const currency = dto.currency ?? 'USD';
    const schedule = await this.getOrCreateSchedule(storeId, sellerId, currency);
    const oldFrequency = schedule.frequency;

    if (dto.frequency !== undefined) schedule.frequency = dto.frequency;
    if (dto.dayOfWeek !== undefined) schedule.dayOfWeek = dto.dayOfWeek;
    if (dto.dayOfMonth !== undefined) schedule.dayOfMonth = dto.dayOfMonth;
    if (dto.minimumAmount !== undefined) schedule.minimumAmount = dto.minimumAmount;
    if (dto.isEnabled !== undefined) schedule.isEnabled = dto.isEnabled;
    if (dto.defaultPayoutMethodId !== undefined) schedule.defaultPayoutMethodId = dto.defaultPayoutMethodId;

    // Recompute next payout date
    const nextDate = this.computeNextPayoutDate(schedule);
    if (nextDate) schedule.nextPayoutAt = nextDate;

    await schedule.save();

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'payout_schedule_changed',
      description: dto.frequency && dto.frequency !== oldFrequency
        ? `${oldFrequency} → ${dto.frequency} payout schedule`
        : 'Payout schedule updated',
      actorId: sellerId,
      actorRole: 'seller',
      targetType: 'payout_schedule',
      ip,
      userAgent,
    });

    return schedule;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAX REPORTS
  // ═══════════════════════════════════════════════════════════════════════════

  async getTaxReports(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    return this.taxModel.find({ storeId }).sort({ year: -1, period: 1 }).lean();
  }

  async generateTaxReport(sellerId: string, storeId: string, year: number, period: string, currency = 'USD') {
    await this.verifyStoreOwnership(sellerId, storeId);

    const validPeriods = ['q1', 'q2', 'q3', 'q4', 'annual'];
    if (!validPeriods.includes(period)) throw new BadRequestException('Invalid period — use q1, q2, q3, q4, or annual');

    const { from, to } = this.getPeriodDateRange(year, period);
    const stats = await this.getPeriodStats(storeId, from, to, currency);
    const txCount = await this.txModel.countDocuments({ storeId, currency, status: 'completed', createdAt: { $gte: from, $lte: to } });

    const netRevenue = this.round(stats.sale - stats.fee - stats.refund);
    const estimatedTax = this.round(netRevenue * ESTIMATED_TAX_RATE);

    const report = await this.taxModel.findOneAndUpdate(
      { storeId, year, period, currency },
      {
        storeId, sellerId, year, period, currency,
        fromDate: from, toDate: to,
        totalRevenue: stats.sale,
        totalFees: stats.fee,
        totalRefunds: stats.refund,
        totalPayouts: stats.payout,
        netRevenue,
        estimatedTax,
        transactionCount: txCount,
        generatedAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' },
    );

    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  async getAnalytics(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const months = Math.min(12, parseInt(query.months) || 6);
    const currency = (query.currency as string) || 'USD';
    const now = new Date();

    // Build monthly revenue for last N months
    const monthlyData: Array<{ month: string; revenue: number; fees: number; refunds: number; net: number }> = [];
    for (let i = months - 1; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const to   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const stats = await this.getPeriodStats(storeId, from, to, currency);
      monthlyData.push({
        month: from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        revenue: stats.sale,
        fees: stats.fee,
        refunds: stats.refund,
        net: this.round(stats.sale - stats.fee - stats.refund),
      });
    }

    // Overall balance summary
    const balance = await this.getOrCreateBalance(storeId, sellerId, currency);

    // Payment type breakdown for current month
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthStats = await this.getPeriodStats(storeId, thisMonthStart, now, currency);

    return {
      currency,
      monthly: monthlyData,
      totals: {
        totalRevenue: balance.totalRevenue,
        totalFees: balance.totalFees,
        totalRefunds: balance.totalRefunds,
        totalPayouts: balance.totalPayouts,
        netRevenue: this.round(balance.totalRevenue - balance.totalFees - balance.totalRefunds),
      },
      currentMonth: thisMonthStats,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — platform-wide drill-down + payout lifecycle management.
  // Admins act on any store, so these skip seller-ownership checks (existence
  // only, via `verifyStoreExistsForAdmin`) and skip storeId-scoping on ledger
  // queries where the admin explicitly wants a platform-wide view.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The seller "wallet inspector" for admins — a store can hold a balance
   * and payout schedule in more than one currency (USD from Stripe sales,
   * PKR from Pakistan manual-transfer sales — see SellerBalance.currency),
   * so this fetches every currency's document rather than just the USD one,
   * to avoid a PKR-only seller looking like they have zero balance.
   */
  async adminGetSellerFinancialDetails(storeId: string) {
    const store = await this.verifyStoreExistsForAdmin(storeId);

    const [balances, schedules, methods, recentPayouts, seller] = await Promise.all([
      this.balanceModel.find({ storeId }).lean(),
      this.scheduleModel.find({ storeId }).lean(),
      this.methodModel.find({ storeId }).sort({ isDefault: -1, createdAt: -1 }).lean(),
      this.payoutModel.find({ storeId }).sort({ createdAt: -1 }).limit(10).lean(),
      this.sellerModel.findById(store.sellerId).select('name email').lean(),
    ]);

    // A brand-new store has no balance doc yet in any currency — show a
    // zeroed USD placeholder rather than an empty array.
    const balanceRows = balances.length > 0 ? balances : [{
      currency: 'USD', availableBalance: 0, pendingBalance: 0,
      totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0,
      isFlaggedForReview: false, flaggedReason: null,
    }];

    return {
      store: { storeId, name: store.name, sellerId: store.sellerId },
      seller: seller ? { name: (seller as any).name, email: (seller as any).email } : null,
      balances: (balanceRows as any[]).map((b) => ({
        currency: b.currency,
        availableBalance: b.availableBalance,
        pendingBalance: b.pendingBalance,
        totalRevenue: b.totalRevenue,
        totalFees: b.totalFees,
        totalRefunds: b.totalRefunds,
        totalPayouts: b.totalPayouts,
        isFlaggedForReview: b.isFlaggedForReview ?? false,
        flaggedReason: b.flaggedReason ?? null,
      })),
      payoutSchedules: (schedules as any[]).map((s) => ({
        currency: s.currency,
        frequency: s.frequency,
        isEnabled: s.isEnabled,
        minimumAmount: s.minimumAmount,
        nextPayoutAt: s.nextPayoutAt,
      })),
      payoutMethods: methods,
      recentPayouts,
    };
  }

  async adminGetSellerTransactions(storeId: string, query: any) {
    await this.verifyStoreExistsForAdmin(storeId);
    const filter = this.buildTransactionFilter(query, { storeId });
    return this.queryTransactions(filter, query);
  }

  /**
   * Admin-only refinement — `Transaction` doesn't carry a payment method
   * (only `Order.paymentType` does), so a `paymentMethodType` filter
   * (stripe / cash_on_delivery / manual_bank_transfer) resolves the matching
   * order ids first and constrains the ledger query to those.
   */
  private async applyPaymentMethodTypeFilter(filter: Record<string, any>, paymentMethodType?: string): Promise<Record<string, any>> {
    if (!paymentMethodType) return filter;
    const orders = await this.db.repositories.orderModel.find({ paymentType: paymentMethodType }).select('_id').lean();
    return { ...filter, referenceId: { $in: (orders as any[]).map((o) => o._id.toString()) }, referenceType: 'order' };
  }

  async adminGetPlatformTransactions(query: any) {
    const filter = await this.applyPaymentMethodTypeFilter(this.buildTransactionFilter(query), query.paymentMethodType);
    return this.queryTransactions(filter, query);
  }

  async adminExportTransactionsCsv(query: any): Promise<string> {
    const filter = await this.applyPaymentMethodTypeFilter(this.buildTransactionFilter(query), query.paymentMethodType);
    const txs = await this.txModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return this.transactionsToCsv(txs);
  }

  async adminGetPayoutQueue(query: any) {
    const page  = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, clampInt(query.limit, 20, 1, 100));
    const skip  = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (query.status)   filter.status   = query.status;
    if (query.storeId)  filter.storeId  = query.storeId;
    if (query.sellerId) filter.sellerId = query.sellerId;

    const [payouts, total, statusRows] = await Promise.all([
      this.payoutModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.payoutModel.countDocuments(filter),
      this.payoutModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    ]);

    const statusCounts: Record<string, { count: number; amount: number }> = {
      pending: { count: 0, amount: 0 }, processing: { count: 0, amount: 0 },
      completed: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 },
    };
    for (const row of statusRows) {
      if (statusCounts[row._id]) statusCounts[row._id] = { count: row.count, amount: this.round(row.amount) };
    }

    return { payouts, total, page, limit, pages: Math.ceil(total / limit), statusCounts };
  }

  /** Distinguishes "no such payout" from "already actioned" after a failed atomic claim. */
  private async throwPayoutNotActionable(payoutId: string, verb: string): Promise<never> {
    const existing = await this.payoutModel.findById(payoutId).select('status').lean<{ status: string }>();
    if (!existing) throw new NotFoundException('Payout not found');
    throw new BadRequestException(`Cannot ${verb} a payout with status "${existing.status}"`);
  }

  /**
   * Marks a pending/processing payout as completed. There is no live payment-processor
   * integration anywhere in this codebase (payouts, like COD orders, are fulfilled
   * manually outside the app) — this records that an admin has confirmed the transfer
   * was actually sent via their bank/PayPal/Stripe dashboard. It does not itself move money.
   */
  async adminApprovePayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    // The method may have been edited (back to pending_verification) or deleted
    // after the seller requested this payout — never wire money to a destination
    // nobody has verified. The admin can reject instead.
    const pending = await this.payoutModel.findOne({ _id: payoutId, status: { $in: ['pending', 'processing'] } }).select('payoutMethodId').lean<{ payoutMethodId: string }>();
    if (pending && pending.payoutMethodId !== 'admin-manual') {
      const method = await this.methodModel.findById(pending.payoutMethodId).select('status').lean<{ status: string }>();
      if (!method || method.status !== 'active') {
        throw new BadRequestException('The payout method is no longer verified — reject this payout, or have the seller re-verify the method');
      }
    }

    // Atomic claim: only one caller can move the payout out of pending/processing,
    // so a double-click or a racing reject/approve can never both act on it.
    const payout = await this.payoutModel.findOneAndUpdate(
      { _id: payoutId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'completed', processedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!payout) return this.throwPayoutNotActionable(payoutId, 'approve');

    this.activityLogService.log({
      storeId: payout.storeId,
      category: 'finance',
      action: 'payout_approved',
      description: `Payout of ${payout.currency || 'USD'} ${payout.amount.toFixed(2)} approved and marked completed`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: payoutId,
      targetType: 'payout',
      ip, userAgent,
    });

    this.notificationsService.notify({
      recipientId: payout.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PAYOUT_COMPLETED,
      title: 'Payout completed',
      body: `Your ${payout.currency || 'USD'} ${payout.amount.toFixed(2)} payout has been sent.`,
      data: { payoutId },
    }).catch(() => {});

    return payout;
  }

  /** Rejects a pending/processing payout and returns the deducted funds to the seller's available balance via a reversing ledger entry (the original ledger history is never edited). */
  async adminRejectPayout(payoutId: string, adminId: string, reason: string, ip?: string, userAgent?: string) {
    const payout = await this.withTransaction(async (session) => {
      // Claim first, inside the transaction: a concurrent reject/approve either
      // wins the claim (and we find nothing to do) or conflicts and retries.
      // Nothing is credited unless THIS call moved the payout to 'failed'.
      const claimed = await this.payoutModel.findOneAndUpdate(
        { _id: payoutId, status: { $in: ['pending', 'processing'] } },
        { $set: { status: 'failed', failureReason: reason, processedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!claimed) return this.throwPayoutNotActionable(payoutId, 'reject');

      const currency = claimed.currency || 'USD';
      const balance = await this.getOrCreateBalance(claimed.storeId, claimed.sellerId, currency, session);
      const balanceBefore = balance.availableBalance;
      balance.availableBalance = this.round(balance.availableBalance + claimed.amount);
      balance.totalPayouts = this.round(balance.totalPayouts - claimed.amount);
      this.reevaluateDebtFlag(balance);
      await balance.save({ session });

      const tx = new this.txModel({
        storeId: claimed.storeId,
        sellerId: claimed.sellerId,
        currency,
        type: 'adjustment',
        amount: claimed.amount,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: `Payout rejected — funds returned (${reason})`,
        referenceId: payoutId,
        referenceType: 'payout',
        status: 'completed',
        metadata: { rejectedBy: adminId, reason },
      });
      await tx.save({ session });
      return claimed;
    });

    this.activityLogService.log({
      storeId: payout.storeId,
      category: 'finance',
      action: 'payout_rejected',
      description: `Payout of ${payout.currency || 'USD'} ${payout.amount.toFixed(2)} rejected — ${reason}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: payoutId,
      targetType: 'payout',
      ip, userAgent,
    });

    this.notificationsService.notify({
      recipientId: payout.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PAYOUT_REJECTED,
      title: 'Payout rejected',
      body: `Your ${payout.currency || 'USD'} ${payout.amount.toFixed(2)} payout was rejected (${reason}) — the funds have been returned to your available balance.`,
      data: { payoutId, reason },
    }).catch(() => {});

    return payout;
  }

  /** Re-attempts a previously-rejected payout — re-deducts the balance (rejecting already refunded it) and puts it back into `processing`. */
  async adminRetryFailedPayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const payout = await this.withTransaction(async (session) => {
      // Claim inside the transaction so two concurrent retries can't both
      // re-deduct; if the balance check below throws, the claim rolls back too.
      const claimed = await this.payoutModel.findOneAndUpdate(
        { _id: payoutId, status: 'failed' },
        { $set: { status: 'processing', failureReason: null, processedAt: null } },
        { returnDocument: 'after', session },
      );
      if (!claimed) {
        if (!(await this.payoutModel.exists({ _id: payoutId }))) throw new NotFoundException('Payout not found');
        throw new BadRequestException('Only failed payouts can be retried');
      }

      const currency = claimed.currency || 'USD';
      const balance = await this.getOrCreateBalance(claimed.storeId, claimed.sellerId, currency, session);
      if (claimed.amount > balance.availableBalance) {
        throw new BadRequestException(
          `Cannot retry — available balance (${currency} ${balance.availableBalance.toFixed(2)}) is less than the payout amount (${currency} ${claimed.amount.toFixed(2)})`,
        );
      }

      const balanceBefore = balance.availableBalance;
      balance.availableBalance = this.round(balance.availableBalance - claimed.amount);
      balance.totalPayouts = this.round(balance.totalPayouts + claimed.amount);
      await balance.save({ session });

      const tx = new this.txModel({
        storeId: claimed.storeId,
        sellerId: claimed.sellerId,
        currency,
        type: 'payout',
        amount: -claimed.amount,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: `Payout retry — ${claimed.payoutMethodSnapshot?.bankName || claimed.payoutMethodSnapshot?.type || 'payout method'}`,
        referenceId: payoutId,
        referenceType: 'payout',
        status: 'completed',
        metadata: { retriedBy: adminId },
      });
      await tx.save({ session });
      return claimed;
    });

    this.activityLogService.log({
      storeId: payout.storeId,
      category: 'finance',
      action: 'payout_retried',
      description: `Payout of ${payout.currency || 'USD'} ${payout.amount.toFixed(2)} re-queued for processing`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: payoutId,
      targetType: 'payout',
      ip, userAgent,
    });

    this.notificationsService.notify({
      recipientId: payout.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PAYOUT_RETRIED,
      title: 'Payout re-queued',
      body: `Your ${payout.currency || 'USD'} ${payout.amount.toFixed(2)} payout is being processed again.`,
      data: { payoutId },
    }).catch(() => {});

    return payout;
  }

  /** Admin-initiated off-cycle payout (corrections/manual reconciliation) — completed immediately, no approval step needed since an admin is the one creating it. */
  async adminCreateManualPayout(
    storeId: string, adminId: string,
    amount: number, payoutMethodId: string | undefined, notes: string | undefined,
    ip?: string, userAgent?: string,
  ) {
    const store = await this.verifyStoreExistsForAdmin(storeId);
    amount = this.normalizeAmount(amount);

    let methodSnapshot: { type: string; bankName: string | null; accountLast4?: string } = {
      type: 'manual', bankName: null, accountLast4: 'ADMIN',
    };
    let resolvedMethodId = 'admin-manual';
    let currency = 'USD';
    if (payoutMethodId) {
      const method = await this.methodModel.findOne({ _id: payoutMethodId, storeId });
      if (!method) throw new NotFoundException('Payout method not found');
      if (method.status !== 'active') throw new BadRequestException('Payout method is not verified/active');
      methodSnapshot = { type: method.type, bankName: method.bankName, accountLast4: method.accountLast4 ?? undefined };
      resolvedMethodId = payoutMethodId;
      currency = method.currency || 'USD';
    }

    const payout = await this.withTransaction(async (session) => {
      const balance = await this.getOrCreateBalance(storeId, store.sellerId, currency, session);
      if (amount > balance.availableBalance) {
        throw new BadRequestException(`Insufficient balance — available: ${currency} ${balance.availableBalance.toFixed(2)}`);
      }
      // Duplicate guard: a double-click / retry issuing the same manual payout
      // within a minute. Concurrent calls both touch this balance doc, so the
      // transaction serialises them and the second one lands here.
      const duplicate = await this.payoutModel.exists({
        storeId, amount, currency, payoutMethodId: resolvedMethodId, status: 'completed',
        createdAt: { $gte: new Date(Date.now() - 60_000) },
      }).session(session);
      if (duplicate) {
        throw new ConflictException('An identical manual payout was just issued — refusing to pay twice');
      }

      const balanceBefore = balance.availableBalance;
      balance.availableBalance = this.round(balance.availableBalance - amount);
      balance.totalPayouts = this.round(balance.totalPayouts + amount);
      await balance.save({ session });

      const createdPayout = new this.payoutModel({
        storeId, sellerId: store.sellerId, amount, currency,
        payoutMethodId: resolvedMethodId,
        payoutMethodSnapshot: methodSnapshot,
        notes: notes || 'Manual payout issued by admin',
        status: 'completed',
        processedAt: new Date(),
      });
      await createdPayout.save({ session });

      const tx = new this.txModel({
        storeId, sellerId: store.sellerId, currency,
        type: 'payout',
        amount: -amount,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: notes || 'Manual payout (admin-initiated)',
        referenceId: (createdPayout as any)._id.toString(),
        referenceType: 'payout',
        status: 'completed',
        metadata: { manualByAdmin: adminId },
      });
      await tx.save({ session });

      return createdPayout;
    });

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'manual_payout_issued',
      description: `Admin issued a manual payout of ${currency} ${amount.toFixed(2)}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: (payout as any)._id.toString(),
      targetType: 'payout',
      ip, userAgent,
    });

    return payout;
  }

  /**
   * Promotes sale transactions past the clearing window from `pendingBalance` to
   * `availableBalance` — previously `CLEARING_DAYS` was defined but nothing ever
   * acted on it, so pending balances never became payout-eligible. Idempotent:
   * once a transaction's status flips to `completed` it's excluded from the next run.
   * Invoked hourly by `SchedulerService` and exposed to admins as a manual trigger.
   */
  async processClearingBalances(): Promise<{ processed: number; totalAmount: number; byCurrency: { currency: string; amount: number }[] }> {
    // No single global cutoff — each sale's own `metadata.clearingDays`
    // (set at recordSale time via clearingDaysForRail) decides when IT
    // becomes eligible, since a card-funded sale must clear later than a
    // bank-transfer one. Fetches every still-pending sale and filters in
    // JS rather than in the query — clearingDays varies per row, so a
    // single Mongo date-range filter can't express it directly.
    const pendingSales = await this.txModel.find({ type: 'sale', status: 'pending' }).lean();
    const now = Date.now();

    let processed = 0;
    let totalAmount = 0;
    // `totalAmount` blends every currency (kept for backward compatibility)
    // — `byCurrency` is the correct figure to actually display, since PKR
    // and USD amounts cleared in the same run must never be summed together.
    const totalsByCurrency = new Map<string, number>();

    for (const tx of pendingSales as any[]) {
      const clearingDays = tx.metadata?.clearingDays ?? CLEARING_DAYS;
      const eligibleAt = new Date(tx.createdAt).getTime() + clearingDays * 24 * 60 * 60 * 1000;
      if (eligibleAt > now) continue; // not yet past its own clearing window

      const netAmount = tx.metadata?.netAmount ?? 0;
      const currency = tx.currency || 'USD';
      try {
        const credited = await this.withTransaction(async (session) => {
          // Claim the sale row first. If the hourly cron and an admin trigger (or
          // two instances) race on the same row, only the one that flips
          // pending→completed may credit the balance.
          const claim = await this.txModel.updateOne(
            { _id: tx._id, status: 'pending' },
            { $set: { status: 'completed' } },
            { session },
          );
          if (claim.modifiedCount !== 1) return null;
          if (netAmount > 0) {
            const balance = await this.getOrCreateBalance(tx.storeId, tx.sellerId, currency, session);
            // A refund that overdrew the seller can leave pendingBalance
            // NEGATIVE (see recordRefund). Clamping that to 0 would forgive the
            // debt and release the full sale to availableBalance, so the
            // shortfall is netted against what this sale releases instead —
            // available + pending stays exactly conserved.
            const pendingAfter = this.round(balance.pendingBalance - netAmount);
            if (pendingAfter >= 0) {
              balance.pendingBalance = pendingAfter;
              balance.availableBalance = this.round(balance.availableBalance + netAmount);
            } else {
              balance.pendingBalance = 0;
              balance.availableBalance = this.round(balance.availableBalance + netAmount + pendingAfter);
            }
            this.reevaluateDebtFlag(balance);
            await balance.save({ session });
          }
          return netAmount;
        });
        if (credited === null) continue; // already cleared by someone else
        processed += 1;
        if (credited > 0) {
          totalAmount = this.round(totalAmount + credited);
          totalsByCurrency.set(currency, this.round((totalsByCurrency.get(currency) ?? 0) + credited));
        }
      } catch (err: any) {
        // One poison row must not starve every later sale on every run.
        this.logger.error(`Clearing failed for sale tx ${tx._id}: ${err?.message}`, err?.stack);
      }
    }

    const byCurrency = [...totalsByCurrency.entries()].map(([currency, amount]) => ({ currency, amount }));
    return { processed, totalAmount, byCurrency };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL — called by other modules (OrdersService, etc.)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a completed sale and deduct platform + processing fees.
   * Call this from OrdersService when an order is marked as completed.
   *
   * The platform-fee rate is now resolved per-store from the store's
   * PlatformPlan (`transactionFeeRate`) instead of the flat `PLATFORM_FEE_RATE`
   * constant — this is the single biggest financial incentive to upgrade a
   * platform tier (3% → 1% → 0.5% → 0%). `PLATFORM_FEE_RATE` remains as the
   * fallback for a store with no platform-plan record yet (pre-launch stores).
   */
  /**
   * `platformSponsoredUSD` (default 0) is the portion of `saleAmount` that
   * came from a `sponsorType: 'platform'` campaign discount — the caller
   * (OrdersService) has already folded it INTO `saleAmount` so the seller is
   * credited as if that discount never happened; this param only controls
   * the extra audit-trail entry and the `campaignId`'s running subsidy
   * total below, it does not change the balance math itself.
   */
  /** The ONE commission calculation for order sales (commission rules: seller
   *  override / category / default) — shared by `recordSale` and the COD
   *  commission debit so the two can never drift. */
  private async platformCommission(storeId: string, saleAmount: number) {
    const { rate, source } = await this.commissionRulesService.resolveRate(storeId);
    return { rate, source, platformFee: this.round(saleAmount * rate) };
  }

  /**
   * `paymentMethodType` ('stripe' | 'cash_on_delivery' | 'manual_bank_transfer')
   * gates the card-processing-fee component: it models Stripe's real 2.9%+$0.30
   * card-network fee, which is only ever actually incurred on a Stripe sale —
   * charging it on a COD or manual-bank-transfer sale would deduct a cost the
   * platform never paid. Defaults to 'stripe' only as a defensive fallback for
   * a caller that doesn't pass it; every real call site always does.
   */
  async recordSale(
    storeId: string, sellerId: string, orderId: string, saleAmount: number, description: string,
    platformSponsoredUSD = 0, campaignId?: string | null, currency = 'USD', paymentMethodType = 'stripe',
    fulfillmentMode?: string | null,
    shippingCredit = 0,
  ) {
    // Nothing was paid for and no platform-funded discount is owed (a free order): there is no sale to
    // credit and no commission to take, so no ledger rows at all.
    if (!(saleAmount > 0) && !(shippingCredit > 0)) return;
    // Cash collected by the seller's own courier never reaches the platform —
    // crediting sale-minus-commission here would pay the seller for money they
    // already hold. Debit the commission instead.
    if (isSellerCollectedCod(paymentMethodType, { fulfillmentMode })) {
      return this.recordCodCommissionDebit(storeId, sellerId, orderId, saleAmount, platformSponsoredUSD, campaignId, currency);
    }
    const chargesProcessingFee = paymentMethodType === 'stripe';
    const { rate: platformFeeRate, source: feeRateSource, platformFee } = await this.platformCommission(storeId, saleAmount);
    // The card network charges on everything the buyer paid, shipping included; the platform
    // commission is on the sale only — never on shipping, which passes through to the seller.
    const processingFee = chargesProcessingFee ? this.round((saleAmount + shippingCredit) * PAYMENT_PROCESSING_RATE + PAYMENT_PROCESSING_FIXED) : 0;
    const netAmount     = this.round(saleAmount - platformFee - processingFee + shippingCredit);

    await this.withTransaction(async (session) => {
      // Idempotent per (order, store): a repeated call (double-click on
      // "completed", two admins approving the same proof, markPaid racing
      // approve, a retry after a partial failure) must never credit twice.
      // Concurrent callers both update this store's balance document, so
      // Mongo's write-conflict retry serialises them and the loser lands here.
      const alreadyRecorded = await this.txModel.exists({
        storeId, referenceId: orderId, referenceType: 'order', type: 'sale',
      }).session(session);
      if (alreadyRecorded) {
        this.logger.warn(`recordSale skipped — sale for order ${orderId} / store ${storeId} already recorded`);
        return;
      }

      const balance = await this.getOrCreateBalance(storeId, sellerId, currency, session);
      const balanceBefore = balance.availableBalance;

      // Sale credit goes to pending for CLEARING_DAYS days
      balance.pendingBalance  = this.round(balance.pendingBalance + netAmount);
      balance.totalRevenue    = this.round(balance.totalRevenue + saleAmount);
      balance.totalFees       = this.round(balance.totalFees + platformFee + processingFee);
      // A credit can pay down a prior debt (see recordRefund) — re-check
      // whether the balance has climbed back to non-negative.
      this.reevaluateDebtFlag(balance);
      await balance.save({ session });

      // Ledger: sale entry
      const saleTx = new this.txModel({
        storeId, sellerId, currency,
        type: 'sale',
        amount: saleAmount,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: description || `Sale — Order #${orderId}`,
        referenceId: orderId,
        referenceType: 'order',
        status: 'pending',
        metadata: { platformFee, processingFee, netAmount, clearingDays: clearingDaysForRail(paymentMethodType), feeRate: platformFeeRate, feeRateSource, ...(shippingCredit > 0 ? { shippingCredit } : {}) },
      });
      await saleTx.save({ session });

      // Ledger: fee entry
      const feeTx = new this.txModel({
        storeId, sellerId, currency,
        type: 'fee',
        amount: -(platformFee + processingFee),
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: chargesProcessingFee
          ? `Platform Fee (${(platformFeeRate * 100).toFixed(1)}%) + Card Processing — Order #${orderId}`
          : `Platform Fee (${(platformFeeRate * 100).toFixed(1)}%) — Order #${orderId}`,
        referenceId: orderId,
        referenceType: 'order',
        status: 'completed',
        metadata: { platformFee, processingFee, paymentMethodType },
      });
      await feeTx.save({ session });

      // Ledger: shipping audit entry — informational only (already folded into
      // `netAmount` above, no commission taken on it), so the seller's history can
      // show the shipping line separately from the sale. Same idempotency as the sale.
      if (shippingCredit > 0) {
        await new this.txModel({
          storeId, sellerId, currency,
          type: 'adjustment',
          amount: shippingCredit,
          balanceBefore: balance.availableBalance,
          balanceAfter: balance.availableBalance,
          description: `Shipping — Order #${orderId} (no commission)`,
          referenceId: orderId,
          referenceType: 'order',
          status: 'completed',
          metadata: { shippingCredit: true },
        }).save({ session });
      }

      // Ledger: platform-subsidy audit entry — informational only, doesn't move
      // the balance again (already folded into `saleAmount`/netAmount above);
      // it exists purely so the seller's transaction history and the admin
      // finance dashboard can both explain why this sale paid out more than
      // the buyer's checkout total for that store.
      if (platformSponsoredUSD > 0) {
        const subsidyTx = new this.txModel({
          storeId, sellerId, currency,
          type: 'platform_subsidy',
          amount: platformSponsoredUSD,
          balanceBefore: balance.availableBalance,
          balanceAfter: balance.availableBalance,
          description: `Platform-sponsored sale discount — Order #${orderId}`,
          referenceId: orderId,
          referenceType: 'order',
          status: 'completed',
          metadata: { campaignId: campaignId ?? null },
        });
        await subsidyTx.save({ session });

        if (campaignId) {
          await this.db.repositories.campaignModel.findByIdAndUpdate(
            campaignId,
            { $inc: { totalPlatformSubsidyUSD: platformSponsoredUSD } },
            { session },
          );
        }
      }
    });
  }

  /** True if this store/order was settled by a COD commission debit (as
   *  opposed to a legacy sale credit, or not settled at all). */
  private async findCodCommissionDebit(storeId: string, orderId: string, session?: ClientSession) {
    return this.txModel.findOne(
      { storeId, referenceId: orderId, referenceType: 'order', type: 'fee', 'metadata.codCommission': true },
      null,
      { session },
    ).lean() as Promise<any>;
  }

  /**
   * One entry point for "a paid sub-order is being refunded/returned — fix the
   * seller's ledger". Seller-collected COD that was settled by a commission
   * DEBIT: the seller returns the cash by hand and the debited commission is
   * credited back in proportion to the refunded share (no refund debit — they
   * were never credited the sale). Everything else (card, bank transfer,
   * platform-fulfilled COD, and COD orders settled by the OLD sale credit)
   * debits the refund exactly as before.
   *
   * @param refundedBuyerAmount refunded value in the ORDER currency
   * @param sellerOrderTotal    the sub-order's total in the same currency (proportion denominator)
   * @param sellerDebitAmount   refunded value in the seller's settlement currency
   * @param refKey              stable id of this return/refund (idempotency)
   */
  async recordRefundForSellerOrder(args: {
    order: { paymentType?: string | null };
    sellerOrder: { fulfillmentMode?: string | null };
    storeId: string; sellerId: string; orderId: string;
    refundedBuyerAmount: number; sellerOrderTotal: number; sellerDebitAmount: number;
    refKey: string; currency: string; description: string;
    actorId?: string; actorRole?: string; targetType?: string;
  }) {
    if (isSellerCollectedCod(args.order.paymentType, args.sellerOrder) && (await this.findCodCommissionDebit(args.storeId, args.orderId))) {
      const fraction = args.sellerOrderTotal > 0 ? Math.min(1, args.refundedBuyerAmount / args.sellerOrderTotal) : 1;
      return this.reverseCodCommission(args.storeId, args.sellerId, args.orderId, args.refKey, fraction, args.currency);
    }
    return this.recordRefund(args.storeId, args.sellerId, args.orderId, args.sellerDebitAmount, args.actorId, args.actorRole, {
      description: args.description, targetType: args.targetType ?? 'order', currency: args.currency,
    });
  }

  /**
   * Credits back `fraction` (0–1] of the commission debited for this COD
   * order, so the seller does not pay commission on goods that were returned.
   * Idempotent per (store, order, refKey) and capped so the total credited back
   * can never exceed what was debited.
   */
  async reverseCodCommission(storeId: string, sellerId: string, orderId: string, refKey: string, fraction: number, currency = 'USD') {
    return this.withTransaction(async (session) => {
      const debit = await this.findCodCommissionDebit(storeId, orderId, session);
      if (!debit) return { creditedBack: 0 };

      const dup = await this.txModel.exists({
        storeId, referenceId: orderId, referenceType: 'order', type: 'adjustment', 'metadata.codCommissionReversalRef': refKey,
      }).session(session);
      if (dup) return { creditedBack: 0 };

      const priorRows = await this.txModel.find(
        { storeId, referenceId: orderId, referenceType: 'order', type: 'adjustment', 'metadata.codCommissionReversalRef': { $exists: true } },
        null, { session },
      ).lean() as any[];
      const alreadyBack = priorRows.reduce((sum, r) => sum + (r.amount || 0), 0);
      const originalCommission = Math.abs(debit.amount);
      const credit = this.round(Math.min(originalCommission - alreadyBack, originalCommission * Math.min(1, Math.max(0, fraction))));
      if (!(credit > 0)) return { creditedBack: 0 };

      const balance = await this.getOrCreateBalance(storeId, sellerId, debit.currency ?? currency, session);
      const balanceBefore = balance.availableBalance;
      balance.availableBalance = this.round(balance.availableBalance + credit);
      balance.totalFees = this.round(balance.totalFees - credit);
      this.reevaluateDebtFlag(balance);
      await balance.save({ session });

      await new this.txModel({
        storeId, sellerId, currency: debit.currency ?? currency,
        type: 'adjustment',
        amount: credit,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: `COD commission credited back (returned goods) — Order #${orderId}`,
        referenceId: orderId,
        referenceType: 'order',
        status: 'completed',
        metadata: { codCommissionReversalRef: refKey, fraction },
      }).save({ session });
      return { creditedBack: credit };
    });
  }

  /**
   * COD sale in 'seller' fulfillment: the seller's courier collected the cash,
   * so the seller already holds the money. The platform's commission
   * (`saleAmount` × rate) is DEBITED from the seller's availableBalance — which
   * may go negative (flagged for review; payouts need availableBalance ≥ amount
   * so they are blocked until future sales net the debt off at clearing).
   * Platform-sponsored campaign discounts are still owed to the seller (the
   * buyer paid less cash because the platform funded part of the price), so
   * they are credited. Idempotent per (store, order): skipped if this
   * store/order already has a sale or fee entry (including orders credited by
   * the old behaviour).
   */
  private async recordCodCommissionDebit(
    storeId: string, sellerId: string, orderId: string, saleAmount: number,
    platformSponsoredUSD = 0, campaignId?: string | null, currency = 'USD',
  ) {
    const { rate: feeRate, source: feeRateSource, platformFee: commission } = await this.platformCommission(storeId, saleAmount);

    const { justFlagged, balanceAfter } = await this.withTransaction(async (session) => {
      const already = await this.txModel.exists({
        storeId, referenceId: orderId, referenceType: 'order', type: { $in: ['sale', 'fee'] },
      }).session(session);
      if (already) {
        this.logger.warn(`recordCodCommissionDebit skipped — order ${orderId} / store ${storeId} already settled`);
        return { justFlagged: false, balanceAfter: null as number | null };
      }

      const balance = await this.getOrCreateBalance(storeId, sellerId, currency, session);
      const balanceBefore = balance.availableBalance;
      balance.availableBalance = this.round(balance.availableBalance - commission + platformSponsoredUSD);
      balance.totalRevenue = this.round(balance.totalRevenue + saleAmount);
      balance.totalFees = this.round(balance.totalFees + commission);
      const flag = this.reevaluateDebtFlag(
        balance,
        `COD commission on order #${orderId} (${currency} ${commission.toFixed(2)}) was debited — the seller collected the cash, so the balance went negative`,
      );
      await balance.save({ session });

      await new this.txModel({
        storeId, sellerId, currency,
        type: 'fee',
        amount: -commission,
        balanceBefore,
        balanceAfter: this.round(balance.availableBalance - platformSponsoredUSD),
        description: `COD commission (${(feeRate * 100).toFixed(1)}%) — Order #${orderId} (cash collected by seller)`,
        referenceId: orderId,
        referenceType: 'order',
        status: 'completed',
        metadata: { codCommission: true, saleAmount, platformFee: commission, processingFee: 0, feeRate, feeRateSource, paymentMethodType: 'cash_on_delivery' },
      }).save({ session });

      if (platformSponsoredUSD > 0) {
        await new this.txModel({
          storeId, sellerId, currency,
          type: 'platform_subsidy',
          amount: platformSponsoredUSD,
          balanceBefore: this.round(balance.availableBalance - platformSponsoredUSD),
          balanceAfter: balance.availableBalance,
          description: `Platform-sponsored sale discount — Order #${orderId}`,
          referenceId: orderId,
          referenceType: 'order',
          status: 'completed',
          metadata: { campaignId: campaignId ?? null, codCommission: true },
        }).save({ session });
        if (campaignId) {
          await this.db.repositories.campaignModel.findByIdAndUpdate(
            campaignId, { $inc: { totalPlatformSubsidyUSD: platformSponsoredUSD } }, { session },
          );
        }
      }
      return { justFlagged: flag.justFlagged, balanceAfter: balance.availableBalance };
    });

    if (justFlagged) {
      this.activityLogService.log({
        storeId,
        category: 'finance',
        action: 'seller_balance_negative',
        description: `Store ${storeId}'s balance went negative (${balanceAfter}) after the COD commission on order #${orderId}. Payouts are blocked until future sales cover it.`,
        actorId: 'system',
        actorRole: 'system',
        targetId: storeId,
        targetType: 'seller_balance',
        isSecurityAlert: true,
      });
    }
  }

  /**
   * Credits a seller's balance with their share of subscription revenue
   * collected from their own store's subscribers. Mirrors `recordSale`'s
   * ledger shape (pending → available after CLEARING_DAYS via the same
   * clearing cron) so subscription and order revenue behave identically
   * from the seller's point of view. `platformCommissionUSD` is passed in
   * already computed by the caller (SubscriptionsService), since the
   * commission rate for subscription revenue is configured independently
   * of the order-sale PLATFORM_FEE_RATE.
   */
  async recordSubscriptionRevenue(
    storeId: string, sellerId: string, invoiceId: string,
    sellerPayoutUSD: number, platformCommissionUSD: number, description: string,
  ) {
    await this.withTransaction(async (session) => {
      // Idempotent per invoice (same reasoning as recordSale): a retried or racing call
      // must never credit the seller twice for one subscription payment.
      const alreadyRecorded = await this.txModel.exists({
        storeId, referenceId: invoiceId, referenceType: 'subscription_invoice', type: 'sale',
      }).session(session);
      if (alreadyRecorded) {
        this.logger.warn(`recordSubscriptionRevenue skipped — invoice ${invoiceId} / store ${storeId} already recorded`);
        return;
      }

      const balance = await this.getOrCreateBalance(storeId, sellerId, 'USD', session);
      const balanceBefore = balance.availableBalance;

      balance.pendingBalance = this.round(balance.pendingBalance + sellerPayoutUSD);
      balance.totalRevenue   = this.round(balance.totalRevenue + sellerPayoutUSD + platformCommissionUSD);
      balance.totalFees      = this.round(balance.totalFees + platformCommissionUSD);
      this.reevaluateDebtFlag(balance);
      await balance.save({ session });

      const saleTx = new this.txModel({
        storeId, sellerId, currency: 'USD',
        type: 'sale',
        amount: this.round(sellerPayoutUSD + platformCommissionUSD),
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description,
        referenceId: invoiceId,
        referenceType: 'subscription_invoice',
        status: 'pending',
        metadata: { platformCommissionUSD, sellerPayoutUSD, clearingDays: CLEARING_DAYS, revenueType: 'subscription' },
      });
      await saleTx.save({ session });

      const feeTx = new this.txModel({
        storeId, sellerId, currency: 'USD',
        type: 'fee',
        amount: -platformCommissionUSD,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: `Platform subscription commission — invoice reference ${invoiceId}`,
        referenceId: invoiceId,
        referenceType: 'subscription_invoice',
        status: 'completed',
      });
      await feeTx.save({ session });
    });
  }

  /**
   * Record a refund — reverses the net sale amount from available or pending
   * balance. Call this from OrdersService when a refund is issued, or from
   * the Stripe webhook handler on `charge.refunded`/`charge.dispute.created`.
   * Platform commission already taken at sale time is NOT refunded (the
   * seller absorbs the full refund amount) — if the refund exceeds what's
   * still held (seller already withdrew it), the excess drives the balance
   * negative and flags the seller account for admin review rather than
   * silently failing or being ignored (see `reevaluateDebtFlag`).
   */
  async recordRefund(
    storeId: string, sellerId: string, referenceId: string, refundAmount: number,
    actorId?: string, actorRole?: string,
    opts?: { referenceType?: 'order' | 'subscription_invoice' | 'platform_plan_invoice'; description?: string; targetType?: string; currency?: string },
  ) {
    const referenceType = opts?.referenceType ?? 'order';
    const currency = opts?.currency ?? 'USD';

    const { balanceAfter, justFlagged } = await this.withTransaction(async (session) => {
      const balance = await this.getOrCreateBalance(storeId, sellerId, currency, session);
      const balanceBefore = balance.availableBalance;

      // Deduct from available first, then pending if not enough — allowed to
      // go negative (that negative number IS the seller's debt against
      // future earnings, see class doc comment above).
      if (balance.availableBalance >= refundAmount) {
        balance.availableBalance = this.round(balance.availableBalance - refundAmount);
      } else {
        const fromAvailable = balance.availableBalance;
        balance.availableBalance = 0;
        balance.pendingBalance   = this.round(balance.pendingBalance - (refundAmount - fromAvailable));
      }
      balance.totalRefunds = this.round(balance.totalRefunds + refundAmount);

      const { justFlagged } = this.reevaluateDebtFlag(
        balance,
        `Refund of ${refundAmount.toFixed(2)} ${currency} on order #${referenceId} exceeded the seller's held balance — funds were likely already paid out`,
      );
      await balance.save({ session });

      const tx = new this.txModel({
        storeId, sellerId, currency,
        type: 'refund',
        amount: -refundAmount,
        balanceBefore,
        balanceAfter: balance.availableBalance,
        description: opts?.description ?? `Refund — Order #${referenceId}`,
        referenceId,
        referenceType,
        status: 'completed',
      });
      await tx.save({ session });

      return { balanceAfter: balance.availableBalance, justFlagged };
    });

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'refund_issued',
      description: opts?.description ?? `Order #${referenceId} — ${refundAmount.toFixed(2)} ${currency} refunded`,
      actorId: actorId ?? sellerId,
      actorRole: actorRole ?? 'seller',
      targetId: referenceId,
      targetType: opts?.targetType ?? 'order',
    });

    if (justFlagged) {
      this.activityLogService.log({
        storeId,
        category: 'finance',
        action: 'seller_balance_negative',
        description: `Store ${storeId}'s balance went negative after refunding order #${referenceId} — the seller had likely already withdrawn these funds. Flagged for admin review.`,
        actorId: actorId ?? sellerId,
        actorRole: actorRole ?? 'seller',
        targetId: storeId,
        targetType: 'seller_balance',
        isSecurityAlert: true,
      });
    }

    return { balanceAfter };
  }
}
