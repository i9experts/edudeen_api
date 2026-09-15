/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { FinanceService } from '../finance/finance.service';
import { resolveDateRange, enumerateBuckets } from '../analytics/utils/analytics-date.util';
import { round } from '../common/number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from '../analytics/utils/analytics-cache.util';
import { getPlatformEarnings } from '../common/platform-earnings.util';
import { toCsv } from '../analytics/utils/csv.util';
import { PdfReportBuilder } from '../analytics/utils/pdf-report.util';
import { SUPPORTED_CURRENCIES } from '../exchange-rate/schemas/exchange-rate.schema';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { ActivityLogService } from '../activity-log/activity-log.service';

const CACHE_TTL_SECONDS = 600; // 10 minutes — same convention as admin/seller analytics

/**
 * Platform-wide finance oversight for admins. Read-heavy platform aggregations
 * (overview, revenue/commission trends, seller-balance listing, reports) are
 * implemented here directly against `DatabaseService.repositories` — the same
 * split used for `AdminAnalyticsService` vs seller `AnalyticsService`. Anything
 * that mutates a payout or a seller's balance delegates to `FinanceService`
 * (`adminApprovePayout`, `adminRejectPayout`, etc.) so that ledger-writing logic
 * exists exactly once, shared with the seller-facing endpoints.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly financeService: FinanceService,
    private readonly adminConfigService: AdminConfigService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  private async cached<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    return withAnalyticsCache(this.redis, cacheKey, CACHE_TTL_SECONDS, compute);
  }

  private key(section: string, query: Record<string, any>) {
    return buildAnalyticsCacheKey('admin-finance', 'platform', section, query);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. DASHBOARD OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('overview', { from, to }), async () => {
      const [byTypeRows, balanceTotalsRows, payoutStatusRows, sellersWithBalance, earnings, flaggedSellersCount, pendingVerificationMethodsCount, pendingManualPaymentsCount] = await Promise.all([
        // `currency` is included in the group key — PKR and USD transactions
        // must never be summed into one blended gmv/refunds/netRevenue figure.
        this.r.transactionModel.aggregate([
          { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
        ]),
        this.r.sellerBalanceModel.aggregate([
          {
            $group: {
              _id: '$currency',
              totalAvailable: { $sum: '$availableBalance' },
              totalPending: { $sum: '$pendingBalance' },
              totalRevenue: { $sum: '$totalRevenue' },
              totalFees: { $sum: '$totalFees' },
              totalRefunds: { $sum: '$totalRefunds' },
              totalPayouts: { $sum: '$totalPayouts' },
            },
          },
        ]),
        this.r.payoutModel.aggregate([{ $group: { _id: { status: '$status', currency: '$currency' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
        this.r.sellerBalanceModel.countDocuments({}),
        getPlatformEarnings(this.r.transactionModel, this.r.subscriptionInvoiceModel, from, to),
        this.r.sellerBalanceModel.countDocuments({ isFlaggedForReview: true }),
        this.r.payoutMethodModel.countDocuments({ status: 'pending_verification' }),
        this.r.manualPaymentProofModel.countDocuments({ status: 'pending' }),
      ]);

      const currencies = new Set<string>(SUPPORTED_CURRENCIES as readonly string[]);
      for (const row of byTypeRows) currencies.add(row._id.currency ?? 'USD');
      for (const row of balanceTotalsRows) currencies.add(row._id ?? 'USD');

      const balancesByCurrency = new Map(balanceTotalsRows.map((r: any) => [r._id ?? 'USD', r]));
      const earningsByCurrency = new Map(earnings.byCurrency.map((e) => [e.currency, e]));

      const byCurrency = [...currencies].map((currency) => {
        const saleRow = byTypeRows.find((r: any) => r._id.type === 'sale' && (r._id.currency ?? 'USD') === currency);
        const refundRow = byTypeRows.find((r: any) => r._id.type === 'refund' && (r._id.currency ?? 'USD') === currency);
        const gmv = round(saleRow?.total ?? 0);
        const refunds = round(refundRow?.total ?? 0);
        const balances: any = balancesByCurrency.get(currency) ?? { totalAvailable: 0, totalPending: 0, totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0 };
        const currencyEarnings = earningsByCurrency.get(currency) ?? { commission: 0, processingFees: 0, subscriptionRevenue: 0, total: 0 };

        return {
          currency,
          gmv,
          netRevenue: round(gmv - refunds),
          refunds,
          totalOrders: saleRow?.count ?? 0,
          platformEarnings: currencyEarnings.total,
          platformCommission: currencyEarnings.commission,
          subscriptionRevenue: currencyEarnings.subscriptionRevenue,
          paymentProcessingFees: currencyEarnings.processingFees,
          sellerBalances: {
            totalAvailable: round(balances.totalAvailable ?? 0),
            totalPending: round(balances.totalPending ?? 0),
          },
          lifetimeTotals: {
            totalRevenue: round(balances.totalRevenue ?? 0),
            totalFees: round(balances.totalFees ?? 0),
            totalRefunds: round(balances.totalRefunds ?? 0),
            totalPayouts: round(balances.totalPayouts ?? 0),
          },
        };
      }).filter((c) => c.gmv !== 0 || c.sellerBalances.totalAvailable !== 0 || c.sellerBalances.totalPending !== 0 || c.lifetimeTotals.totalRevenue !== 0);

      // Grouped by {status, currency} — a PKR payout and a USD payout in the
      // same status must never be summed into one blended "amount".
      const payoutStatuses = ['pending', 'processing', 'completed', 'failed'];
      const payoutQueue: Record<string, { count: number; amount: number; byCurrency: { currency: string; count: number; amount: number }[] }> = {};
      for (const status of payoutStatuses) {
        const rowsForStatus = payoutStatusRows.filter((r: any) => r._id.status === status);
        payoutQueue[status] = {
          count: rowsForStatus.reduce((s: number, r: any) => s + r.count, 0),
          amount: round(rowsForStatus.reduce((s: number, r: any) => s + r.amount, 0)),
          byCurrency: rowsForStatus.map((r: any) => ({ currency: r._id.currency ?? 'USD', count: r.count, amount: round(r.amount) })),
        };
      }

      return {
        success: true,
        data: {
          period: { from, to },
          byCurrency,
          sellersWithBalance,
          flaggedSellersCount,
          pendingVerificationMethodsCount,
          pendingManualPaymentsCount,
          payoutQueue,
          note: '"byCurrency" breaks every figure down per settlement currency — PKR and USD are never summed into one blended number. Each entry\'s gmv/netRevenue/refunds/totalOrders are scoped to the selected period; sellerBalances/lifetimeTotals are current, all-time snapshots regardless of the date filter.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. PLATFORM REVENUE / COMMISSION TRENDS
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueOverTime(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('revenue-over-time', { from, to, granularity }), async () => {
      // `currency` is part of the group key — a PKR seller's sale and a USD
      // seller's sale must never be added together into one grossRevenue point.
      const rows = await this.r.transactionModel.aggregate([
        { $match: { type: { $in: ['sale', 'refund'] }, status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } } } },
      ]);

      const currencies = new Set<string>(SUPPORTED_CURRENCIES as readonly string[]);
      for (const row of rows) currencies.add(row._id.currency ?? 'USD');

      const byBucket = new Map<number, Map<string, { gross: number; refunds: number }>>();
      for (const row of rows) {
        const t = row._id.bucket.getTime();
        const currency = row._id.currency ?? 'USD';
        const perCurrency = byBucket.get(t) ?? new Map<string, { gross: number; refunds: number }>();
        const entry = perCurrency.get(currency) ?? { gross: 0, refunds: 0 };
        if (row._id.type === 'sale') entry.gross = row.total; else entry.refunds = row.total;
        perCurrency.set(currency, entry);
        byBucket.set(t, perCurrency);
      }

      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const perCurrency = byBucket.get(bucket.getTime());
        const byCurrency = [...currencies].map((currency) => {
          const e = perCurrency?.get(currency) ?? { gross: 0, refunds: 0 };
          return { currency, grossRevenue: round(e.gross), netRevenue: round(e.gross - e.refunds) };
        }).filter((c) => c.grossRevenue !== 0 || c.netRevenue !== 0);
        return { date: bucket, byCurrency };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  async getCommissionOverTime(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('commission-over-time', { from, to, granularity }), async () => {
      const rows = await this.r.transactionModel.aggregate([
        { $match: { type: 'sale', status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', currency: '$currency' }, commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
      ]);

      const currencies = new Set<string>(SUPPORTED_CURRENCIES as readonly string[]);
      for (const row of rows) currencies.add(row._id.currency ?? 'USD');

      const byBucket = new Map<number, Map<string, any>>();
      for (const row of rows) {
        const t = row._id.bucket.getTime();
        const perCurrency = byBucket.get(t) ?? new Map<string, any>();
        perCurrency.set(row._id.currency ?? 'USD', row);
        byBucket.set(t, perCurrency);
      }

      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const perCurrency = byBucket.get(bucket.getTime());
        const byCurrency = [...currencies].map((currency) => {
          const row = perCurrency?.get(currency);
          return { currency, commission: round(row?.commission ?? 0), processingFees: round(row?.processingFees ?? 0) };
        }).filter((c) => c.commission !== 0 || c.processingFees !== 0);
        return { date: bucket, byCurrency };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. SELLER BALANCES
  // ═══════════════════════════════════════════════════════════════════════

  async getSellerBalances(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const sort = ['availableBalance', 'pendingBalance', 'totalRevenue', 'totalPayouts'].includes(query.sort) ? query.sort : 'availableBalance';
    const order = query.order === 'asc' ? 1 : -1;

    return this.cached(this.key('seller-balances', { page, limit, sort, order, search: query.search ?? '', flaggedOnly: query.flaggedOnly ?? '' }), async () => {
      const balances = await this.r.sellerBalanceModel.find({}).lean();
      const sellerIds = [...new Set(balances.map((b: any) => b.sellerId))];
      const storeIds = balances.map((b: any) => b.storeId);

      const [sellers, stores] = await Promise.all([
        this.r.sellerModel.find({ _id: { $in: sellerIds } }).select('name email').lean(),
        this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean(),
      ]);
      const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));
      const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

      let rows = balances.map((b: any) => ({
        storeId: b.storeId,
        storeName: storeMap.get(b.storeId)?.name ?? 'Unknown store',
        sellerId: b.sellerId,
        sellerName: sellerMap.get(b.sellerId)?.name ?? 'Unknown seller',
        sellerEmail: sellerMap.get(b.sellerId)?.email ?? '',
        availableBalance: b.availableBalance,
        pendingBalance: b.pendingBalance,
        totalRevenue: b.totalRevenue,
        totalFees: b.totalFees,
        totalRefunds: b.totalRefunds,
        totalPayouts: b.totalPayouts,
        currency: b.currency,
        isFlaggedForReview: b.isFlaggedForReview ?? false,
        flaggedReason: b.flaggedReason ?? null,
      }));

      if (query.search) {
        const q = String(query.search).toLowerCase();
        rows = rows.filter((r) => r.sellerName.toLowerCase().includes(q) || r.sellerEmail.toLowerCase().includes(q) || r.storeName.toLowerCase().includes(q));
      }

      if (query.flaggedOnly === 'true' || query.flaggedOnly === true) {
        rows = rows.filter((r) => r.isFlaggedForReview);
      }

      rows.sort((a: any, b: any) => order * (a[sort] - b[sort]));

      const total = rows.length;
      const start = (page - 1) * limit;

      return {
        success: true,
        data: {
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          sellers: rows.slice(start, start + limit),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // D. SELLER DRILL-DOWN — delegates to FinanceService (no ledger logic duplicated)
  // ═══════════════════════════════════════════════════════════════════════

  async getSellerFinancialDetails(storeId: string) {
    const data = await this.financeService.adminGetSellerFinancialDetails(storeId);
    return { success: true, data };
  }

  async getSellerTransactions(storeId: string, query: any) {
    const data = await this.financeService.adminGetSellerTransactions(storeId, query);
    return { success: true, data };
  }

  /** Joins `storeName` onto rows that only carry a bare `storeId` — a display-layer concern, kept out of `FinanceService` since seller-facing endpoints never need it (a seller already knows their own store's name). */
  private async attachStoreNames<T extends { storeId: string }>(rows: T[]): Promise<Array<T & { storeName: string }>> {
    if (rows.length === 0) return [];
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
    const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s.name as string]));
    return rows.map((r) => ({ ...r, storeName: storeMap.get(r.storeId) ?? 'Unknown store' }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E. PLATFORM TRANSACTIONS — delegates to FinanceService, enriched with store names
  // ═══════════════════════════════════════════════════════════════════════

  async getPlatformTransactions(query: any) {
    const data = await this.financeService.adminGetPlatformTransactions(query);
    const transactions = await this.attachStoreNames(data.transactions as any[]);
    return { success: true, data: { ...data, transactions } };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. PAYOUT QUEUE & LIFECYCLE — delegates to FinanceService, enriched with store names
  // ═══════════════════════════════════════════════════════════════════════

  async getPayoutQueue(query: any) {
    const data = await this.financeService.adminGetPayoutQueue(query);
    const payouts = await this.attachStoreNames(data.payouts as any[]);
    return { success: true, data: { ...data, payouts } };
  }

  async approvePayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminApprovePayout(payoutId, adminId, ip, userAgent);
    return { success: true, data };
  }

  async rejectPayout(payoutId: string, adminId: string, reason: string, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminRejectPayout(payoutId, adminId, reason, ip, userAgent);
    return { success: true, data };
  }

  async retryPayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminRetryFailedPayout(payoutId, adminId, ip, userAgent);
    return { success: true, data };
  }

  async createManualPayout(storeId: string, adminId: string, amount: number, payoutMethodId: string | undefined, notes: string | undefined, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminCreateManualPayout(storeId, adminId, amount, payoutMethodId, notes, ip, userAgent);
    return { success: true, data };
  }

  async triggerClearingBalances() {
    const data = await this.financeService.processClearingBalances();
    return { success: true, data };
  }

  async triggerScheduledPayouts() {
    const data = await this.financeService.processScheduledPayouts();
    return { success: true, data };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAYOUT METHOD VERIFICATION — every new method starts 'pending_verification'
  // (see PayoutMethod schema) since no automated bank/wallet verification
  // exists yet; an admin must review and activate it before a seller can
  // withdraw to it.
  // ═══════════════════════════════════════════════════════════════════════

  async getPendingVerificationMethods() {
    const methods = await this.r.payoutMethodModel.find({ status: 'pending_verification' }).sort({ createdAt: 1 }).lean();
    const enriched = await this.attachStoreNames(methods as any[]);
    return { success: true, data: enriched };
  }

  async verifyPayoutMethod(storeId: string, methodId: string, adminId: string, approve: boolean, note?: string) {
    const data = await this.financeService.adminVerifyPayoutMethod(storeId, methodId, adminId, approve, note);
    return { success: true, data };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // G. REPORTS
  // ═══════════════════════════════════════════════════════════════════════

  async getRefundReport(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('refunds', { from, to }), async () => {
      // Grouped by {storeId, currency} — a store's own settlement currency is
      // stable in practice, but reading it off the ledger row itself (rather
      // than assuming) is what lets the top-level total be broken down
      // correctly instead of summing PKR and USD refunds into one number.
      const refundRows = await this.r.transactionModel.aggregate([
        { $match: { type: 'refund', createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { storeId: '$storeId', currency: '$currency' }, totalRefunded: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
      ]);

      const storeIds = refundRows.map((r) => r._id.storeId);
      const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
      const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

      const byStore = refundRows
        .map((r) => ({
          storeId: r._id.storeId,
          storeName: storeMap.get(r._id.storeId)?.name ?? 'Unknown store',
          currency: r._id.currency ?? 'USD',
          totalRefunded: round(r.totalRefunded),
          count: r.count,
        }))
        .sort((a, b) => b.totalRefunded - a.totalRefunded);

      const byCurrencyMap = new Map<string, { totalRefunded: number; count: number }>();
      for (const row of byStore) {
        const entry = byCurrencyMap.get(row.currency) ?? { totalRefunded: 0, count: 0 };
        entry.totalRefunded = round(entry.totalRefunded + row.totalRefunded);
        entry.count += row.count;
        byCurrencyMap.set(row.currency, entry);
      }
      const byCurrency = [...byCurrencyMap.entries()].map(([currency, v]) => ({ currency, ...v }));

      return {
        success: true,
        data: {
          period: { from, to },
          byCurrency,
          byStore,
          note: 'Platform commission is not clawed back when a refund is issued (see finance.service.ts#recordRefund — only the seller\'s balance is debited) — the platform keeps its original commission on refunded sales. This report shows refund volume only, not a commission adjustment. Totals are broken down per settlement currency — PKR and USD are never summed together.',
        },
      };
    });
  }

  async getTaxReports(query: any) {
    const filter: Record<string, any> = {};
    if (query.storeId) filter.storeId = query.storeId;
    if (query.year) filter.year = Number(query.year);

    const reports = await this.r.taxReportModel.find(filter).sort({ year: -1, period: 1 }).limit(200).lean();
    const storeIds = [...new Set(reports.map((r: any) => r.storeId))];
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
    const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: reports.map((r: any) => ({ ...r, storeName: storeMap.get(r.storeId)?.name ?? 'Unknown store' })),
    };
  }

  async getSettlementReport(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('settlement', { from, to }), async () => {
      const [byTypeRows, balanceTotalsRows] = await Promise.all([
        this.r.transactionModel.aggregate([
          { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } } } },
        ]),
        this.r.sellerBalanceModel.aggregate([{ $group: { _id: '$currency', totalAvailable: { $sum: '$availableBalance' }, totalPending: { $sum: '$pendingBalance' } } }]),
      ]);

      const currencies = new Set<string>(SUPPORTED_CURRENCIES as readonly string[]);
      for (const row of byTypeRows) currencies.add(row._id.currency ?? 'USD');
      for (const row of balanceTotalsRows) currencies.add(row._id ?? 'USD');

      const balancesByCurrency = new Map(balanceTotalsRows.map((r: any) => [r._id ?? 'USD', r]));

      const byCurrency = [...currencies].map((currency) => {
        const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0, adjustment: 0 };
        for (const row of byTypeRows) if ((row._id.currency ?? 'USD') === currency) stats[row._id.type] = round(row.total);
        const balances: any = balancesByCurrency.get(currency) ?? { totalAvailable: 0, totalPending: 0 };
        return {
          currency,
          grossSales: stats.sale,
          platformFeesCollected: stats.fee,
          refundsIssued: stats.refund,
          payoutsDisbursed: stats.payout,
          adjustments: stats.adjustment,
          outstandingObligation: {
            availableBalance: round(balances.totalAvailable ?? 0),
            pendingBalance: round(balances.totalPending ?? 0),
            totalOwedToSellers: round((balances.totalAvailable ?? 0) + (balances.totalPending ?? 0)),
          },
        };
      }).filter((c) => c.grossSales !== 0 || c.outstandingObligation.totalOwedToSellers !== 0);

      return {
        success: true,
        data: {
          period: { from, to },
          byCurrency,
          note: '"outstandingObligation" is a current snapshot (not scoped to the selected period) — it answers "if every seller withdrew today, how much would leave the platform", per settlement currency. PKR and USD are never summed together.',
        },
      };
    });
  }

  async getMonthlyReport(query: any) {
    const months = Math.min(12, Number(query.months) || 6);
    const now = new Date();

    return this.cached(this.key('monthly', { months }), async () => {
      const monthly: Array<Record<string, any>> = [];

      for (let i = months - 1; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

        const [byTypeRows, earnings] = await Promise.all([
          this.r.transactionModel.aggregate([
            { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
            { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } } } },
          ]),
          getPlatformEarnings(this.r.transactionModel, this.r.subscriptionInvoiceModel, from, to),
        ]);

        const currencies = new Set<string>(SUPPORTED_CURRENCIES as readonly string[]);
        for (const row of byTypeRows) currencies.add(row._id.currency ?? 'USD');
        const earningsByCurrency = new Map(earnings.byCurrency.map((e) => [e.currency, e]));

        const byCurrency = [...currencies].map((currency) => {
          const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0 };
          for (const row of byTypeRows) if ((row._id.currency ?? 'USD') === currency) stats[row._id.type] = round(row.total);
          const currencyEarnings = earningsByCurrency.get(currency) ?? { commission: 0, subscriptionRevenue: 0, total: 0 };
          return {
            currency,
            gmv: stats.sale,
            refunds: stats.refund,
            payouts: stats.payout,
            platformCommission: currencyEarnings.commission,
            subscriptionRevenue: currencyEarnings.subscriptionRevenue,
            platformEarnings: currencyEarnings.total,
          };
        }).filter((c) => c.gmv !== 0 || c.refunds !== 0 || c.payouts !== 0 || c.platformEarnings !== 0);

        monthly.push({
          month: from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          byCurrency,
        });
      }

      return { success: true, data: { monthly } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // H. EXPORT
  // ═══════════════════════════════════════════════════════════════════════

  async exportCsv(query: any): Promise<string> {
    const section = query.section ?? 'transactions';

    switch (section) {
      case 'payouts': {
        const { from, to } = resolveDateRange(query);
        const rows = await this.r.payoutModel.find({ createdAt: { $gte: from, $lte: to } }).sort({ createdAt: -1 }).limit(5000).lean();
        return toCsv(
          ['Payout ID', 'Store ID', 'Amount', 'Status', 'Method', 'Requested At', 'Processed At'],
          (rows as any[]).map((p) => [
            p._id.toString(), p.storeId, p.amount.toFixed(2), p.status, p.payoutMethodSnapshot?.type ?? '',
            new Date(p.createdAt).toISOString().split('T')[0],
            p.processedAt ? new Date(p.processedAt).toISOString().split('T')[0] : '',
          ]),
        );
      }
      case 'sellers': {
        const data = await this.getSellerBalances({ ...query, page: 1, limit: 5000 });
        return toCsv(
          ['Store', 'Seller', 'Email', 'Available', 'Pending', 'Total Revenue', 'Total Payouts'],
          data.data.sellers.map((s: any) => [s.storeName, s.sellerName, s.sellerEmail, s.availableBalance.toFixed(2), s.pendingBalance.toFixed(2), s.totalRevenue.toFixed(2), s.totalPayouts.toFixed(2)]),
        );
      }
      case 'refunds': {
        const report = await this.getRefundReport(query);
        return toCsv(
          ['Store', 'Currency', 'Total Refunded', 'Count'],
          report.data.byStore.map((r: any) => [r.storeName, r.currency, r.totalRefunded.toFixed(2), r.count]),
        );
      }
      case 'tax': {
        const reports = await this.getTaxReports(query);
        return toCsv(
          ['Store', 'Year', 'Period', 'Revenue', 'Fees', 'Refunds', 'Net', 'Estimated Tax'],
          reports.data.map((r: any) => [r.storeName, r.year, r.period, r.totalRevenue.toFixed(2), r.totalFees.toFixed(2), r.totalRefunds.toFixed(2), r.netRevenue.toFixed(2), r.estimatedTax.toFixed(2)]),
        );
      }
      case 'settlement': {
        const s = await this.getSettlementReport(query);
        const rows: [string, string][] = [];
        for (const c of s.data.byCurrency) {
          rows.push(
            [`Gross Sales (${c.currency})`, c.grossSales.toFixed(2)],
            [`Platform Fees Collected (${c.currency})`, c.platformFeesCollected.toFixed(2)],
            [`Refunds Issued (${c.currency})`, c.refundsIssued.toFixed(2)],
            [`Payouts Disbursed (${c.currency})`, c.payoutsDisbursed.toFixed(2)],
            [`Available Balance owed (${c.currency})`, c.outstandingObligation.availableBalance.toFixed(2)],
            [`Pending Balance owed (${c.currency})`, c.outstandingObligation.pendingBalance.toFixed(2)],
          );
        }
        return toCsv(['Metric', 'Amount'], rows);
      }
      case 'transactions':
      default:
        return this.financeService.adminExportTransactionsCsv(query);
    }
  }

  async exportPdf(query: any): Promise<Buffer> {
    const { from, to } = resolveDateRange(query);

    const [overview, settlement, refunds] = await Promise.all([
      this.getOverview(query),
      this.getSettlementReport(query),
      this.getRefundReport(query),
    ]);

    const rangeLabel = `${from.toISOString().split('T')[0]} to ${to.toISOString().split('T')[0]}`;
    const pdf = await PdfReportBuilder.create('Edudeen — Platform Finance Report', `Period: ${rangeLabel}`);

    pdf.addSectionHeading('Overview');
    // One key-value grid per settlement currency — PKR and USD figures are
    // never blended into a single "$" number (see AdminFinanceService's
    // getOverview comment for why).
    for (const c of overview.data.byCurrency) {
      pdf.addKeyValueGrid([
        { label: `GMV (${c.currency})`, value: c.gmv.toFixed(2) },
        { label: `Net Revenue (${c.currency})`, value: c.netRevenue.toFixed(2) },
        { label: `Platform Commission (${c.currency})`, value: c.platformCommission.toFixed(2) },
        { label: `Subscription Revenue (${c.currency})`, value: c.subscriptionRevenue.toFixed(2) },
        { label: `Total Available owed (${c.currency})`, value: c.sellerBalances.totalAvailable.toFixed(2) },
        { label: `Total Pending owed (${c.currency})`, value: c.sellerBalances.totalPending.toFixed(2) },
      ]);
    }

    pdf.addSectionHeading('Settlement');
    for (const c of settlement.data.byCurrency) {
      pdf.addTable([`Metric (${c.currency})`, 'Amount'], [
        ['Gross Sales', c.grossSales.toFixed(2)],
        ['Platform Fees Collected', c.platformFeesCollected.toFixed(2)],
        ['Refunds Issued', c.refundsIssued.toFixed(2)],
        ['Payouts Disbursed', c.payoutsDisbursed.toFixed(2)],
      ]);
    }

    pdf.addSectionHeading('Refunds by Store');
    if (refunds.data.byStore.length > 0) {
      pdf.addTable(
        ['Store', 'Currency', 'Total Refunded', 'Count'],
        refunds.data.byStore.slice(0, 20).map((r: any) => [r.storeName, r.currency, r.totalRefunded.toFixed(2), r.count]),
      );
    } else {
      pdf.addEmptyNote('No refunds recorded in this period.');
    }

    return pdf.build();
  }

  /**
   * Reconciliation: compares, per currency and over the given window, what
   * buyers were charged (Order.totalAmount) against what the ledger
   * actually recorded (sale amounts − platform fees − processing fees +
   * refunds) — the two should always agree; a real drift here means money
   * moved somewhere the ledger doesn't account for and needs investigation,
   * not a currency-conversion display quirk. Read-only; finds discrepancies,
   * never corrects them automatically.
   */
  async getReconciliation(days = 1) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [orders, saleTx, feeTx, refundTx] = await Promise.all([
      this.r.orderModel.aggregate([
        { $match: { createdAt: { $gte: since }, isDelete: false } },
        { $group: { _id: '$currency', totalCollected: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      this.r.transactionModel.aggregate([
        { $match: { type: 'sale', createdAt: { $gte: since } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } },
      ]),
      this.r.transactionModel.aggregate([
        { $match: { type: 'fee', createdAt: { $gte: since } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } }, // stored negative
      ]),
      this.r.transactionModel.aggregate([
        { $match: { type: 'refund', createdAt: { $gte: since } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } }, // stored negative
      ]),
    ]);

    const byCurrency: Record<string, any> = {};
    const ensure = (currency: string) => {
      if (!byCurrency[currency]) {
        byCurrency[currency] = { currency, buyerCollected: 0, orderCount: 0, ledgerNet: 0, fees: 0, refunds: 0 };
      }
      return byCurrency[currency];
    };
    for (const o of orders) { const b = ensure(o._id || 'USD'); b.buyerCollected = round(o.totalCollected); b.orderCount = o.count; }
    for (const t of saleTx) { ensure(t._id || 'USD').ledgerNet += round(t.total); }
    for (const t of feeTx) { ensure(t._id || 'USD').fees += round(t.total); }
    for (const t of refundTx) { ensure(t._id || 'USD').refunds += round(t.total); }

    const TOLERANCE = 0.01; // per-currency rounding tolerance, not a real discrepancy threshold
    const results = Object.values(byCurrency).map((b: any) => {
      // ledgerNet is what sellers were actually credited net-of-fee; fees/refunds are stored as negative deltas already.
      const expectedFromLedger = round(b.ledgerNet + Math.abs(b.fees) + b.refunds);
      const drift = round(b.buyerCollected - expectedFromLedger);
      return { ...b, expectedFromLedger, drift, hasDiscrepancy: Math.abs(drift) > TOLERANCE };
    });

    return {
      success: true,
      data: {
        windowDays: days,
        byCurrency: results,
        hasAnyDiscrepancy: results.some((r) => r.hasDiscrepancy),
      },
    };
  }

  /**
   * Runs `getReconciliation`, PERSISTS the result (previously this was
   * read-only/on-demand only — nothing was ever recorded, so a discrepancy
   * that occurred between two people happening to check the dashboard would
   * go completely unnoticed), and raises an admin security alert for any
   * currency with a real discrepancy. Called by the daily scheduled job
   * (`SchedulerService#runReconciliation`, `runLocked`-protected).
   */
  async runAndPersistReconciliation(days = 1) {
    const { data } = await this.getReconciliation(days);
    const run = await this.r.reconciliationRunModel.create({
      runAt: new Date(),
      results: data.byCurrency,
      hasAnyDiscrepancy: data.hasAnyDiscrepancy,
    });

    if (data.hasAnyDiscrepancy) {
      for (const c of data.byCurrency.filter((r: any) => r.hasDiscrepancy)) {
        await this.activityLogService.log({
          storeId: 'platform',
          category: 'finance',
          action: 'reconciliation_discrepancy_detected',
          description: `Reconciliation drift of ${c.drift} ${c.currency} detected — buyer collected ${c.buyerCollected}, ledger expected ${c.expectedFromLedger}`,
          actorId: 'system',
          actorRole: 'system',
          isSecurityAlert: true,
          targetId: run._id.toString(),
          targetType: 'reconciliation_run',
        });
      }
    }

    return run;
  }

  /** Latest N persisted reconciliation runs — the admin-visible history that
   *  `getReconciliation` alone (on-demand, unpersisted) couldn't provide. */
  async getReconciliationHistory(limit = 30) {
    const runs = await this.r.reconciliationRunModel
      .find({})
      .sort({ runAt: -1 })
      .limit(Math.min(100, limit))
      .lean();
    return { success: true, data: runs };
  }

  /**
   * FX exposure: the platform's net open position per currency, over
   * orders that have been collected but not yet fully settled/paid out
   * (pending clearing window, see FinanceService.CLEARING_DAYS*). Simple
   * by design — a daily snapshot, not a treasury/hedging system.
   */
  async getFxExposure() {
    const pendingSales = await this.r.transactionModel.aggregate([
      { $match: { type: 'sale', status: 'pending' } },
      { $group: { _id: '$currency', pendingAmount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const rates = await this.r.exchangeRateModel.aggregate([
      { $match: { isRejected: false } },
      { $sort: { effectiveFrom: -1 } },
      { $group: { _id: '$currency', ratePerUSD: { $first: '$ratePerUSD' } } },
    ]);
    const rateByCurrency = new Map(rates.map((r: any) => [r._id, r.ratePerUSD]));

    const byCurrency = pendingSales.map((p: any) => {
      const currency = p._id || 'USD';
      const ratePerUSD = currency === 'USD' ? 1 : (rateByCurrency.get(currency) ?? null);
      const pendingUSDEquivalent = ratePerUSD ? round(p.pendingAmount / ratePerUSD) : null;
      return { currency, pendingAmount: round(p.pendingAmount), count: p.count, pendingUSDEquivalent };
    });

    const totalUSDEquivalent = round(byCurrency.reduce((s, b) => s + (b.pendingUSDEquivalent ?? 0), 0));
    const fxConfig = await this.adminConfigService.getFxConfig();
    const threshold = fxConfig?.exposureThresholdUSD ?? 50_000;

    return {
      success: true,
      data: { byCurrency, totalUSDEquivalent, threshold, breached: totalUSDEquivalent > threshold, asOf: new Date() },
    };
  }

  /**
   * Calls `getFxExposure` and raises an admin security alert if it's over
   * threshold. Called by the daily scheduled job
   * (`SchedulerService#checkFxExposure`, `runLocked`-protected) — this was
   * previously entirely absent, so a runaway open position could grow
   * indefinitely with nothing ever flagging it. Kept separate from
   * `getFxExposure` itself so the on-demand admin-dashboard read (which can
   * be called repeatedly just by viewing the page) never spams duplicate
   * alerts — only the once-a-day cron tick does. No automatic
   * hedging/trading — visibility only, matching the rest of this FX
   * system's design.
   */
  async runFxExposureCheck() {
    const { data } = await this.getFxExposure();
    if (data.breached) {
      await this.activityLogService.log({
        storeId: 'platform',
        category: 'finance',
        action: 'fx_exposure_threshold_breached',
        description: `Platform open FX exposure is $${data.totalUSDEquivalent.toFixed(2)}, above the configured $${data.threshold.toFixed(2)} threshold`,
        actorId: 'system',
        actorRole: 'system',
        isSecurityAlert: true,
      });
    }
    return data;
  }
}
