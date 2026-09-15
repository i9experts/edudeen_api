/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import {
  absoluteChange,
  enumerateBuckets,
  nextBucket,
  percentChange,
  resolveDateRange,
} from '../analytics/utils/analytics-date.util';
import { round } from '../analytics/utils/analytics-number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from '../analytics/utils/analytics-cache.util';
import {
  aggregateProductSales,
  allTimeCustomerAggregate,
  itemRefundSumField,
  notCancelledCond,
  periodTotals,
  repeatBuyerPercent,
  sellerOrderMatchStage,
} from '../analytics/utils/order-aggregation.util';
import { toCsv } from '../analytics/utils/csv.util';
import { PdfReportBuilder } from '../analytics/utils/pdf-report.util';
import { getPlatformEarnings as getPlatformEarningsUtil } from '../common/platform-earnings.util';

const CACHE_TTL_SECONDS = 600; // 10 minutes — same convention as seller analytics
const CSV_ROW_LIMIT = 5000;

/**
 * Platform-wide analytics for admins. Built on the exact same `Order`/`sellerOrders`
 * aggregation building blocks as the seller-scoped `AnalyticsService`
 * (`../analytics/utils/order-aggregation.util`) — every function there takes an
 * optional `scopeMatch`; seller analytics always scopes to one store, this service
 * omits the scope for platform-wide totals (or scopes to one store/seller for
 * admin drill-downs via the `storeId`/`sellerId` query filters).
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async cached<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    return withAnalyticsCache(this.redis, cacheKey, CACHE_TTL_SECONDS, compute);
  }

  private key(section: string, scopeLabel: string, query: Record<string, any>) {
    return buildAnalyticsCacheKey('admin-analytics', scopeLabel, section, query);
  }

  /** Builds the sellerOrders-level scope filter from optional `storeId`/`sellerId` drill-down params. `undefined` means platform-wide. */
  private buildScope(query: { storeId?: string; sellerId?: string }): Record<string, any> | undefined {
    const scope: Record<string, any> = {};
    if (query.storeId) scope['sellerOrders.storeId'] = query.storeId;
    if (query.sellerId) scope['sellerOrders.sellerId'] = query.sellerId;
    return Object.keys(scope).length > 0 ? scope : undefined;
  }

  private scopeLabel(scope?: Record<string, any>): string {
    return scope ? JSON.stringify(scope) : 'platform';
  }

  private resolveGranularity(query: any, autoGranularity: 'day' | 'week' | 'month') {
    const override = query.granularity;
    return override === 'day' || override === 'week' || override === 'month' ? override : autoGranularity;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Shared seller-level aggregation (platform-wide "group by sellerId")
  // ═══════════════════════════════════════════════════════════════════════

  private async aggregateSellerSales(from: Date, to: Date, scope?: Record<string, any>) {
    const rows = await this.r.orderModel.aggregate([
      ...sellerOrderMatchStage(from, to, scope),
      { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
      {
        $addFields: {
          itemRefund: itemRefundSumField(),
          itemUnits: { $sum: '$sellerOrders.items.quantity' },
        },
      },
      {
        $group: {
          _id: '$sellerOrders.sellerId',
          orderCount: { $sum: 1 },
          unitsSold: { $sum: '$itemUnits' },
          grossRevenue: { $sum: '$sellerOrders.subtotal' },
          refundedAmount: { $sum: '$itemRefund' },
          buyerIds: { $addToSet: '$userId' },
        },
      },
    ]);

    return rows.map((r: any) => ({
      sellerId: r._id,
      orderCount: r.orderCount,
      unitsSold: r.unitsSold,
      grossRevenue: round(r.grossRevenue),
      refundedAmount: round(r.refundedAmount),
      netRevenue: round(r.grossRevenue - r.refundedAmount),
      uniqueBuyerCount: (r.buyerIds ?? []).length,
    }));
  }

  private async countActiveSellers(from: Date, to: Date, scope?: Record<string, any>): Promise<number> {
    const rows = await this.r.orderModel.aggregate([
      ...sellerOrderMatchStage(from, to, scope),
      { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $group: { _id: '$sellerOrders.sellerId' } },
      { $count: 'total' },
    ]);
    return rows[0]?.total ?? 0;
  }

  /**
   * Platform's own earned revenue for a period — delegates to the shared
   * `getPlatformEarnings` util (also used by `AdminFinanceService`) so this
   * aggregation exists exactly once. Recognized independent of payout-clearing
   * status — clearing is about payout timing, not whether the commission was earned.
   */
  private async getPlatformEarnings(from: Date, to: Date, scope?: Record<string, any>) {
    return getPlatformEarningsUtil(this.r.transactionModel, this.r.subscriptionInvoiceModel, from, to, {
      storeId: scope?.['sellerOrders.storeId'],
      sellerId: scope?.['sellerOrders.sellerId'],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. DASHBOARD OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(query: any) {
    const { from, to, previousFrom, previousTo } = resolveDateRange(query);
    const compare = query.compareToPreviousPeriod === true || query.compareToPreviousPeriod === 'true';
    const scope = this.buildScope(query);

    return this.cached(this.key('overview', this.scopeLabel(scope), { from, to, compare }), async () => {
      const [current, previous, sellersActiveThisMonth, prevSellersActiveThisMonth, platformEarnings, totalSellers, totalStores, activeStores, totalCustomers, newUsers] = await Promise.all([
        periodTotals(this.r.orderModel, from, to, scope),
        periodTotals(this.r.orderModel, previousFrom, previousTo, scope),
        this.countActiveSellers(from, to, scope),
        this.countActiveSellers(previousFrom, previousTo, scope),
        this.getPlatformEarnings(from, to, scope),
        this.r.sellerModel.countDocuments({ isDelete: false }),
        this.r.storeModel.countDocuments({ isDelete: false }),
        this.r.storeModel.countDocuments({ isDelete: false, status: 'active' }),
        this.r.userModel.countDocuments({ isDelete: false }),
        this.r.userModel.countDocuments({ isDelete: false, createdAt: { $gte: from, $lte: to } }),
      ]);

      const refundRatePercent = current.grossRevenue > 0 ? round((current.refundAmount / current.grossRevenue) * 100) : 0;

      const data: Record<string, any> = {
        period: { from, to },
        totalGMV: current.grossRevenue,
        totalRevenue: current.netRevenue,
        totalRevenueChangePercent: percentChange(current.netRevenue, previous.netRevenue),
        platformEarnings: platformEarnings.total,
        platformCommission: platformEarnings.commission,
        subscriptionRevenue: platformEarnings.subscriptionRevenue,
        totalOrders: current.orderCount,
        totalOrdersChange: absoluteChange(current.orderCount, previous.orderCount),
        totalSellers,
        sellersActiveThisMonth,
        sellersActiveThisMonthChange: absoluteChange(sellersActiveThisMonth, prevSellersActiveThisMonth),
        totalStores,
        activeStores,
        totalCustomers,
        newUsers,
        totalRefunds: current.refundAmount,
        refundRatePercent,
        cancelledOrders: current.cancelledCount,
        note: '"totalRevenue" is net order revenue platform-wide (GMV minus refunds) — it is the money that flowed through the marketplace. "platformEarnings" is Edudeen\'s own cut of that (commission + subscription revenue) and is a separate figure, not a component already subtracted from totalRevenue.',
      };

      if (compare) {
        data.previousPeriod = {
          period: { from: previousFrom, to: previousTo },
          totalGMV: previous.grossRevenue,
          totalRevenue: previous.netRevenue,
          totalOrders: previous.orderCount,
          sellersActiveThisMonth: prevSellersActiveThisMonth,
          totalRefunds: previous.refundAmount,
          cancelledOrders: previous.cancelledCount,
        };
      }

      return { success: true, data };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. REVENUE ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueOverTime(query: any) {
    const { from, to, granularity: autoGranularity } = resolveDateRange(query);
    const granularity = this.resolveGranularity(query, autoGranularity);
    const scope = this.buildScope(query);

    return this.cached(this.key('revenue-over-time', this.scopeLabel(scope), { from, to, granularity }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...sellerOrderMatchStage(from, to, scope),
        {
          $addFields: {
            itemRefund: itemRefundSumField(),
            bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } },
          },
        },
        {
          $group: {
            _id: '$bucket',
            grossRevenue: { $sum: { $cond: [notCancelledCond(), '$sellerOrders.subtotal', 0] } },
            refundAmount: { $sum: { $cond: [notCancelledCond(), '$itemRefund', 0] } },
          },
        },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        const gross = round(row?.grossRevenue ?? 0);
        const refund = round(row?.refundAmount ?? 0);
        return { date: bucket, grossRevenue: gross, netRevenue: round(gross - refund) };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  async getRevenueBreakdown(query: any) {
    const { from, to, previousFrom, previousTo } = resolveDateRange(query);
    const compare = query.compareToPreviousPeriod === true || query.compareToPreviousPeriod === 'true';
    const scope = this.buildScope(query);

    return this.cached(this.key('revenue-breakdown', this.scopeLabel(scope), { from, to, compare }), async () => {
      const [orderTotals, platformEarnings, previousOrderTotals, previousPlatformEarnings] = await Promise.all([
        periodTotals(this.r.orderModel, from, to, scope),
        this.getPlatformEarnings(from, to, scope),
        compare ? periodTotals(this.r.orderModel, previousFrom, previousTo, scope) : null,
        compare ? this.getPlatformEarnings(previousFrom, previousTo, scope) : null,
      ]);

      const data: Record<string, any> = {
        period: { from, to },
        oneTimeOrderRevenue: orderTotals.netRevenue,
        recurringSubscriptionRevenue: platformEarnings.subscriptionRevenue,
        platformCommissionRevenue: platformEarnings.commission,
        paymentProcessingFees: platformEarnings.processingFees,
        totalPlatformRevenue: round(platformEarnings.commission + platformEarnings.subscriptionRevenue),
        totalMarketplaceRevenue: round(orderTotals.netRevenue + platformEarnings.subscriptionRevenue),
        note: 'oneTimeOrderRevenue is net seller order revenue (does not belong to the platform); platformCommissionRevenue + recurringSubscriptionRevenue is what Edudeen itself earns. Commission is recognized at sale time regardless of payout-clearing status.',
      };

      if (compare && previousOrderTotals && previousPlatformEarnings) {
        data.previousPeriod = {
          period: { from: previousFrom, to: previousTo },
          oneTimeOrderRevenue: previousOrderTotals.netRevenue,
          recurringSubscriptionRevenue: previousPlatformEarnings.subscriptionRevenue,
          platformCommissionRevenue: previousPlatformEarnings.commission,
          paymentProcessingFees: previousPlatformEarnings.processingFees,
          totalPlatformRevenue: round(previousPlatformEarnings.commission + previousPlatformEarnings.subscriptionRevenue),
          totalMarketplaceRevenue: round(previousOrderTotals.netRevenue + previousPlatformEarnings.subscriptionRevenue),
        };
      }

      return { success: true, data };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. SELLER ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  /** Backs both "Top Sellers" and "Lowest Performing Sellers" — pass `order=asc` for the latter. */
  async getTopSellers(query: any) {
    const { from, to } = resolveDateRange(query);
    const limit = Number(query.limit) || 10;
    const sort = query.sort === 'orders' ? 'orders' : 'revenue';
    const order = query.order === 'asc' ? 'asc' : 'desc';

    return this.cached(this.key('top-sellers', 'platform', { from, to, limit, sort, order }), async () => {
      const rows = await this.aggregateSellerSales(from, to);
      rows.sort((a, b) => {
        const diff = sort === 'orders' ? b.orderCount - a.orderCount : b.netRevenue - a.netRevenue;
        return order === 'asc' ? -diff : diff;
      });

      const top = rows.slice(0, limit);
      const sellers = await this.r.sellerModel.find({ _id: { $in: top.map((r) => r.sellerId) } }).select('name email').lean();
      const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));

      return {
        success: true,
        data: top.map((r) => ({
          sellerId: r.sellerId,
          name: sellerMap.get(r.sellerId)?.name ?? 'Unknown',
          email: sellerMap.get(r.sellerId)?.email ?? '',
          orderCount: r.orderCount,
          unitsSold: r.unitsSold,
          revenue: r.netRevenue,
        })),
      };
    });
  }

  /** Full paginated seller ranking table (every seller, including zero-sales ones) — beyond the top-N of `getTopSellers`. */
  async getSellerPerformance(query: any) {
    const { from, to } = resolveDateRange(query);
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const sort = query.sort === 'orders' ? 'orders' : 'revenue';
    const order = query.order === 'asc' ? 'asc' : 'desc';

    return this.cached(this.key('seller-performance', 'platform', { from, to, page, limit, sort, order }), async () => {
      const [sales, sellers, storeCounts] = await Promise.all([
        this.aggregateSellerSales(from, to),
        this.r.sellerModel.find({ isDelete: false }).select('name email').lean(),
        this.r.storeModel.aggregate([
          { $match: { isDelete: false } },
          { $group: { _id: '$sellerId', storeCount: { $sum: 1 }, activeStoreCount: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } },
        ]),
      ]);

      const salesMap = new Map(sales.map((s) => [s.sellerId, s]));
      const storeCountMap = new Map(storeCounts.map((r: any) => [r._id, r]));

      const merged = sellers.map((s: any) => {
        const id = s._id.toString();
        const sale = salesMap.get(id);
        const stores = storeCountMap.get(id);
        const grossRevenue = sale?.grossRevenue ?? 0;
        const refundedAmount = sale?.refundedAmount ?? 0;
        return {
          sellerId: id,
          name: s.name,
          email: s.email,
          orderCount: sale?.orderCount ?? 0,
          unitsSold: sale?.unitsSold ?? 0,
          revenue: sale?.netRevenue ?? 0,
          refundRatePercent: sale && grossRevenue > 0 ? round((refundedAmount / grossRevenue) * 100) : 0,
          storeCount: stores?.storeCount ?? 0,
          activeStoreCount: stores?.activeStoreCount ?? 0,
        };
      });

      merged.sort((a, b) => {
        const diff = sort === 'orders' ? b.orderCount - a.orderCount : b.revenue - a.revenue;
        return order === 'asc' ? -diff : diff;
      });

      const total = merged.length;
      const start = (page - 1) * limit;
      const pageItems = merged.slice(start, start + limit);

      return {
        success: true,
        data: {
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          sellers: pageItems,
        },
      };
    });
  }

  /** Covers both "Seller Growth" and "Seller Registration Trends" — bucketed new-seller signups plus a running cumulative total. */
  async getSellerRegistrationTrends(query: any) {
    const { from, to, granularity: autoGranularity } = resolveDateRange(query);
    const granularity = this.resolveGranularity(query, autoGranularity);

    return this.cached(this.key('seller-registration-trends', 'platform', { from, to, granularity }), async () => {
      const [rows, totalBefore] = await Promise.all([
        this.r.sellerModel.aggregate([
          { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
          { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
          { $group: { _id: '$bucket', count: { $sum: 1 } } },
        ]),
        this.r.sellerModel.countDocuments({ isDelete: false, createdAt: { $lt: from } }),
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r.count]));
      let cumulative = totalBefore;
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const newSellers = byBucket.get(bucket.getTime()) ?? 0;
        cumulative += newSellers;
        return { date: bucket, newSellers, cumulativeSellers: cumulative };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // D. CUSTOMER ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  async getCustomerAnalytics(query: any) {
    const { from, to, granularity } = resolveDateRange(query);
    const scope = this.buildScope(query);

    return this.cached(this.key('customers', this.scopeLabel(scope), { from, to }), async () => {
      const [allTime, repeatCustomerPercent] = await Promise.all([
        allTimeCustomerAggregate(this.r.orderModel, scope),
        repeatBuyerPercent(this.r.orderModel, from, to, scope),
      ]);
      const firstOrderMap = new Map(allTime.map((c) => [c.userId, c.firstOrderAt]));

      const periodRows = await this.r.orderModel.aggregate([
        ...sellerOrderMatchStage(from, to, scope),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', userId: '$userId' } } },
      ]);

      const activeBuyerIds = new Set<string>();
      const bucketTotals = new Map<number, { newCustomers: number; returningCustomers: number }>();
      for (const row of periodRows) {
        activeBuyerIds.add(row._id.userId);
        const bucketTime = row._id.bucket.getTime();
        const firstOrderAt = firstOrderMap.get(row._id.userId);
        const isNew = !!firstOrderAt && firstOrderAt >= row._id.bucket && firstOrderAt < nextBucket(row._id.bucket, granularity);
        const entry = bucketTotals.get(bucketTime) ?? { newCustomers: 0, returningCustomers: 0 };
        if (isNew) entry.newCustomers += 1; else entry.returningCustomers += 1;
        bucketTotals.set(bucketTime, entry);
      }

      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const totals = bucketTotals.get(bucket.getTime()) ?? { newCustomers: 0, returningCustomers: 0 };
        return { date: bucket, ...totals };
      });

      const avgLifetimeValue = allTime.length > 0
        ? round(allTime.reduce((sum, c) => sum + c.lifetimeValue, 0) / allTime.length)
        : 0;

      const topByLtv = [...allTime].sort((a, b) => b.lifetimeValue - a.lifetimeValue).slice(0, 10);
      const users = await this.r.userModel.find({ _id: { $in: topByLtv.map((c) => c.userId) } }).select('name email').lean();
      const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

      const topCustomers = topByLtv.map((c) => ({
        userId: c.userId,
        name: userMap.get(c.userId)?.name ?? 'Unknown',
        email: userMap.get(c.userId)?.email ?? '',
        totalOrders: c.totalOrders,
        lifetimeValue: c.lifetimeValue,
      }));

      const geoRows = await this.r.orderModel.aggregate([
        ...sellerOrderMatchStage(from, to, scope),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, shippingAddress: { $ne: null } } },
        { $group: { _id: '$shippingAddress.state', orders: { $sum: 1 }, revenue: { $sum: '$sellerOrders.subtotal' } } },
        { $sort: { revenue: -1 } },
      ]);

      return {
        success: true,
        data: {
          granularity,
          activeCustomers: activeBuyerIds.size,
          repeatCustomerPercent,
          newVsReturning: series,
          averageLifetimeValue: avgLifetimeValue,
          topCustomersByLtv: topCustomers,
          geographicBreakdown: geoRows.map((r: any) => ({ state: r._id ?? 'Unknown', orders: r.orders, revenue: round(r.revenue) })),
          note: 'Geographic breakdown covers physical orders only (digital orders have no shippingAddress) — same limitation as seller analytics.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E. PRODUCT ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  async getTopProducts(query: any) {
    const { from, to } = resolveDateRange(query);
    const limit = Number(query.limit) || 10;
    const sort = query.sort === 'units_sold' ? 'units_sold' : 'revenue';
    const scope = this.buildScope(query);

    return this.cached(this.key('top-products', this.scopeLabel(scope), { from, to, limit, sort, categoryId: query.categoryId }), async () => {
      let rows = await aggregateProductSales(this.r.orderModel, from, to, scope);

      if (query.categoryId) {
        const matching = await this.r.productModel.find({ categoryId: query.categoryId, isDelete: false }).select('_id').lean();
        const allowed = new Set(matching.map((p: any) => p._id.toString()));
        rows = rows.filter((r) => allowed.has(r.productId));
      }

      rows.sort((a, b) => (sort === 'units_sold' ? b.unitsSold - a.unitsSold : b.netRevenue - a.netRevenue));

      return {
        success: true,
        data: rows.slice(0, limit).map((r) => ({
          productId: r.productId,
          name: r.name,
          orderCount: r.orderCount,
          unitsSold: r.unitsSold,
          revenue: r.netRevenue,
        })),
      };
    });
  }

  async getTopCategories(query: any) {
    const { from, to } = resolveDateRange(query);
    const limit = Number(query.limit) || 10;
    const sort = query.sort === 'units_sold' ? 'units_sold' : 'revenue';
    const scope = this.buildScope(query);

    return this.cached(this.key('top-categories', this.scopeLabel(scope), { from, to, limit, sort }), async () => {
      const productSales = await aggregateProductSales(this.r.orderModel, from, to, scope);
      if (productSales.length === 0) return { success: true, data: [] };

      const products = await this.r.productModel
        .find({ _id: { $in: productSales.map((p) => p.productId) } })
        .select('categoryId')
        .lean();
      const categoryByProduct = new Map(products.map((p: any) => [p._id.toString(), p.categoryId as string | null]));

      const byCategory = new Map<string, { orderCount: number; unitsSold: number; revenue: number }>();
      for (const p of productSales) {
        // `|| ` (not `??`) deliberately — a product can have `categoryId: ''` (falsy but
        // not nullish), which would otherwise slip past into the Category `$in` lookup
        // below and crash it with a Mongoose ObjectId cast error.
        const categoryId = categoryByProduct.get(p.productId) || 'uncategorized';
        const entry = byCategory.get(categoryId) ?? { orderCount: 0, unitsSold: 0, revenue: 0 };
        entry.orderCount += p.orderCount;
        entry.unitsSold += p.unitsSold;
        entry.revenue += p.netRevenue;
        byCategory.set(categoryId, entry);
      }

      // Some products have a legacy `categoryId` that's a free-text category name
      // (e.g. "Technology") instead of a real Category `_id` reference — only the
      // ones that actually look like a Mongo ObjectId are safe to send into the
      // `$in` lookup below; anything else would crash it with a cast error.
      const allIds = [...byCategory.keys()].filter((id) => id !== 'uncategorized');
      const categoryIds = allIds.filter((id) => isValidObjectId(id));
      const categories = await this.r.categoryModel.find({ _id: { $in: categoryIds } }).select('name').lean();
      const nameMap = new Map(categories.map((c: any) => [c._id.toString(), c.name]));

      const rows = [...byCategory.entries()].map(([categoryId, v]) => ({
        categoryId,
        name: categoryId === 'uncategorized'
          ? 'Uncategorized'
          : isValidObjectId(categoryId)
            ? (nameMap.get(categoryId) ?? 'Unknown')
            : categoryId, // legacy free-text category name — already human-readable as-is
        orderCount: v.orderCount,
        unitsSold: v.unitsSold,
        revenue: round(v.revenue),
      }));

      rows.sort((a, b) => (sort === 'units_sold' ? b.unitsSold - a.unitsSold : b.revenue - a.revenue));
      return { success: true, data: rows.slice(0, limit) };
    });
  }

  async getProductPerformance(query: any) {
    const { from, to } = resolveDateRange(query);
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const scope = this.buildScope(query);

    return this.cached(this.key('product-performance', this.scopeLabel(scope), { from, to, page, limit, categoryId: query.categoryId }), async () => {
      const productFilter: Record<string, any> = { isDelete: false };
      if (query.storeId) productFilter.storeId = query.storeId;
      if (query.sellerId) productFilter.sellerId = query.sellerId;
      if (query.categoryId) productFilter.categoryId = query.categoryId;

      const [sales, products] = await Promise.all([
        aggregateProductSales(this.r.orderModel, from, to, scope),
        this.r.productModel.find(productFilter).select('name').lean(),
      ]);

      const salesMap = new Map(sales.map((s) => [s.productId, s]));
      const productIds = products.map((p: any) => p._id.toString());

      const stockRows = await this.r.productVariantModel.aggregate([
        { $match: { productId: { $in: productIds }, isDelete: false } },
        { $group: { _id: '$productId', stock: { $sum: '$stock' } } },
      ]);
      const stockMap = new Map(stockRows.map((r: any) => [r._id, r.stock]));

      const merged = products.map((p: any) => {
        const id = p._id.toString();
        const sale = salesMap.get(id);
        const stock = stockMap.get(id) ?? 0;
        const unitsSold = sale?.unitsSold ?? 0;
        const revenue = sale?.netRevenue ?? 0;
        const refundedAmount = sale?.refundedAmount ?? 0;
        return {
          productId: id,
          name: p.name,
          unitsSold,
          revenue,
          refundRatePercent: sale && sale.grossRevenue > 0 ? round((refundedAmount / sale.grossRevenue) * 100) : 0,
          currentStock: stock,
          isLowPerformer: unitsSold === 0 && stock > 0,
        };
      });

      merged.sort((a, b) => b.revenue - a.revenue);
      const total = merged.length;
      const start = (page - 1) * limit;

      return {
        success: true,
        data: {
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          products: merged.slice(start, start + limit),
        },
      };
    });
  }

  async getInventoryInsights(query: any) {
    const scope = this.buildScope(query);

    return this.cached(this.key('inventory-insights', this.scopeLabel(scope), {}), async () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);

      const productFilter: Record<string, any> = { isDelete: false, status: 'active' };
      if (query.storeId) productFilter.storeId = query.storeId;
      if (query.sellerId) productFilter.sellerId = query.sellerId;

      const [products, sales30d] = await Promise.all([
        this.r.productModel.find(productFilter).select('name').lean(),
        aggregateProductSales(this.r.orderModel, from, to, scope),
      ]);

      const productIds = products.map((p: any) => p._id.toString());
      const salesMap = new Map(sales30d.map((s) => [s.productId, s.unitsSold]));

      const variants = await this.r.productVariantModel
        .find({ productId: { $in: productIds }, isDelete: false })
        .select('productId stock')
        .lean();
      const stockByProduct = new Map<string, number>();
      for (const v of variants as any[]) {
        stockByProduct.set(v.productId, (stockByProduct.get(v.productId) ?? 0) + v.stock);
      }

      const outOfStock: any[] = [];
      const fastMoving: any[] = [];
      const slowMoving: any[] = [];
      const reorderSuggestions: any[] = [];

      for (const p of products as any[]) {
        const id = p._id.toString();
        const stock = stockByProduct.get(id) ?? 0;
        const unitsSold30d = salesMap.get(id) ?? 0;
        const sellThroughRate = unitsSold30d + stock > 0 ? round((unitsSold30d / (unitsSold30d + stock)) * 100) : 0;

        if (stock <= 0) {
          outOfStock.push({ productId: id, name: p.name, unitsSoldLast30Days: unitsSold30d });
          continue;
        }

        const entry = { productId: id, name: p.name, currentStock: stock, unitsSoldLast30Days: unitsSold30d, sellThroughRatePercent: sellThroughRate };
        if (sellThroughRate >= 50) fastMoving.push(entry);
        else if (unitsSold30d > 0) slowMoving.push(entry);

        const weeklyRate = unitsSold30d / (30 / 7);
        if (weeklyRate > 0 && stock < weeklyRate * 2) {
          reorderSuggestions.push({ productId: id, name: p.name, currentStock: stock, estimatedWeeksRemaining: round(stock / weeklyRate) });
        }
      }

      fastMoving.sort((a, b) => b.sellThroughRatePercent - a.sellThroughRatePercent);
      slowMoving.sort((a, b) => a.sellThroughRatePercent - b.sellThroughRatePercent);

      return {
        success: true,
        data: {
          note: 'Sell-through and reorder suggestions are based on the trailing 30 days across every active product platform-wide (or within the storeId/sellerId filter, if provided). Lost-sales-from-search cross-referencing is not available — no search/view-event tracking exists in this codebase.',
          outOfStockCount: outOfStock.length,
          outOfStock: outOfStock.slice(0, 50),
          fastMoving: fastMoving.slice(0, 20),
          slowMoving: slowMoving.slice(0, 20),
          reorderSuggestions: reorderSuggestions.slice(0, 20),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. ORDER ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  async getOrdersOverTime(query: any) {
    const { from, to, granularity: autoGranularity } = resolveDateRange(query);
    const granularity = this.resolveGranularity(query, autoGranularity);
    const scope = this.buildScope(query);

    return this.cached(this.key('orders-over-time', this.scopeLabel(scope), { from, to, granularity }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...sellerOrderMatchStage(from, to, scope),
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        {
          $group: {
            _id: '$bucket',
            orderCount: { $sum: { $cond: [notCancelledCond(), 1, 0] } },
            cancelledOrdersCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'cancelled'] }, 1, 0] } },
            refundedOrdersCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'refunded'] }, 1, 0] } },
          },
        },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        return {
          date: bucket,
          orderCount: row?.orderCount ?? 0,
          cancelledOrdersCount: row?.cancelledOrdersCount ?? 0,
          refundedOrdersCount: row?.refundedOrdersCount ?? 0,
        };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  async getOrderStatusBreakdown(query: any) {
    const { from, to } = resolveDateRange(query);
    const scope = this.buildScope(query);

    return this.cached(this.key('orders-status-breakdown', this.scopeLabel(scope), { from, to }), async () => {
      const [totals, statusRows] = await Promise.all([
        periodTotals(this.r.orderModel, from, to, scope),
        this.r.orderModel.aggregate([
          ...sellerOrderMatchStage(from, to, scope),
          { $group: { _id: '$sellerOrders.status', count: { $sum: 1 } } },
        ]),
      ]);

      const statusCounts: Record<string, number> = {};
      for (const r of statusRows) statusCounts[r._id] = r.count;

      const totalIncludingCancelled = totals.orderCount + totals.cancelledCount;
      const cancellationRatePercent = totalIncludingCancelled > 0 ? round((totals.cancelledCount / totalIncludingCancelled) * 100) : 0;
      const refundRatePercent = totals.grossRevenue > 0 ? round((totals.refundAmount / totals.grossRevenue) * 100) : 0;

      return {
        success: true,
        data: {
          statusCounts,
          totalOrders: totals.orderCount,
          cancelledOrders: totals.cancelledCount,
          refundedOrders: statusCounts['refunded'] ?? 0,
          avgOrderValue: totals.avgOrderValue,
          cancellationRatePercent,
          refundRatePercent,
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // G. PAYMENT ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  async getPaymentBreakdown(query: any) {
    const { from, to } = resolveDateRange(query);
    const scope = this.buildScope(query);

    return this.cached(this.key('payments-breakdown', this.scopeLabel(scope), { from, to }), async () => {
      const methodRows = await this.r.orderModel.aggregate([
        ...sellerOrderMatchStage(from, to, scope),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: '$paymentType', count: { $sum: 1 }, revenue: { $sum: '$sellerOrders.subtotal' } } },
      ]);
      const labels: Record<string, string> = { cash_on_delivery: 'Cash on Delivery', stripe: 'Card (Stripe)' };
      const methodBreakdown = (methodRows).map((r) => ({
        paymentType: r._id,
        label: labels[r._id] ?? r._id,
        orderCount: r.count,
        revenue: round(r.revenue),
      }));

      // Checkout-level payment attempts — the tri-state succeeded/failed/pending concept lives on
      // `PaymentTransaction`, not on `Order.paymentStatus`. No storeId/sellerId scoping is applied here:
      // a PaymentTransaction can back multiple orders across sellers, so it has no single store/seller owner.
      const statusRows = await this.r.paymentTransactionModel.aggregate([
        { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]);
      const byStatus: Record<string, { count: number; amount: number }> = {
        pending: { count: 0, amount: 0 },
        completed: { count: 0, amount: 0 },
        failed: { count: 0, amount: 0 },
      };
      for (const r of statusRows) {
        if (byStatus[r._id]) byStatus[r._id] = { count: r.count, amount: round(r.amount) };
      }

      return {
        success: true,
        data: {
          methodBreakdown,
          successfulPayments: byStatus.completed,
          failedPayments: byStatus.failed,
          pendingPayments: byStatus.pending,
          note: 'successfulPayments/failedPayments/pendingPayments are checkout-level PaymentTransaction attempts (platform-wide, not filterable by storeId/sellerId — a single payment attempt can span multiple sellers\' orders); methodBreakdown is order-level and does respect the storeId/sellerId filter.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // H. PLATFORM ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  async getPlatformMetrics(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('platform-metrics', 'platform', { from, to, granularity }), async () => {
      const [newSellerRows, newStoreRows, newProductRows, newUsers] = await Promise.all([
        this.r.sellerModel.aggregate([
          { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
          { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
          { $group: { _id: '$bucket', count: { $sum: 1 } } },
        ]),
        this.r.storeModel.aggregate([
          { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
          { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
          { $group: { _id: '$bucket', count: { $sum: 1 } } },
        ]),
        this.r.productModel.aggregate([
          { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
          { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
          { $group: { _id: '$bucket', count: { $sum: 1 } } },
        ]),
        this.r.userModel.find({ isDelete: false, createdAt: { $gte: from, $lte: to } }).select('_id').lean(),
      ]);

      const sellerBucket = new Map((newSellerRows).map((r) => [r._id.getTime(), r.count]));
      const storeBucket = new Map((newStoreRows).map((r) => [r._id.getTime(), r.count]));
      const productBucket = new Map((newProductRows).map((r) => [r._id.getTime(), r.count]));

      const marketplaceGrowth = enumerateBuckets(from, to, granularity).map((bucket) => ({
        date: bucket,
        newSellers: sellerBucket.get(bucket.getTime()) ?? 0,
        newStores: storeBucket.get(bucket.getTime()) ?? 0,
        newProducts: productBucket.get(bucket.getTime()) ?? 0,
      }));

      // Best-effort conversion metric: of users who registered in this period, how many went on to place
      // at least one non-cancelled order. There is no page-view/session/search-event tracking in this
      // codebase to measure any funnel step earlier than "placed an order" (same gap already documented
      // on the seller inventory-insights endpoint).
      const newUserIds = (newUsers as any[]).map((u) => u._id.toString());
      let newUsersWhoOrdered = 0;
      if (newUserIds.length > 0) {
        const converted = await this.r.orderModel.aggregate([
          { $match: { isDelete: false, userId: { $in: newUserIds } } },
          { $unwind: '$sellerOrders' },
          { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
          { $group: { _id: '$userId' } },
        ]);
        newUsersWhoOrdered = converted.length;
      }

      return {
        success: true,
        data: {
          granularity,
          marketplaceGrowth,
          conversionMetrics: {
            newUsersInPeriod: newUserIds.length,
            newUsersWhoOrdered,
            signupToOrderConversionPercent: newUserIds.length > 0 ? round((newUsersWhoOrdered / newUserIds.length) * 100) : 0,
            note: 'Only signup-to-first-order conversion is computable from current data — there is no view/search/session tracking to measure any funnel step upstream of a placed order.',
          },
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // I. EXPORT
  // ═══════════════════════════════════════════════════════════════════════

  async exportCsv(query: any): Promise<string> {
    const { from, to } = resolveDateRange(query);
    const section = query.section ?? 'revenue';
    const scope = this.buildScope(query);

    switch (section) {
      case 'orders': {
        const rows = await this.r.orderModel.aggregate([
          ...sellerOrderMatchStage(from, to, scope),
          { $project: { _id: 0, orderNumber: 1, createdAt: 1, status: '$sellerOrders.status', storeId: '$sellerOrders.storeId', subtotal: '$sellerOrders.subtotal', paymentType: 1 } },
          { $sort: { createdAt: -1 } },
          { $limit: CSV_ROW_LIMIT },
        ]);
        return toCsv(
          ['Order Number', 'Date', 'Status', 'Store ID', 'Subtotal', 'Payment Type'],
          (rows).map((r) => [r.orderNumber, new Date(r.createdAt).toISOString().split('T')[0], r.status, r.storeId, r.subtotal.toFixed(2), r.paymentType ?? '']),
        );
      }
      case 'sellers': {
        const rows = await this.aggregateSellerSales(from, to, scope);
        rows.sort((a, b) => b.netRevenue - a.netRevenue);
        const top = rows.slice(0, CSV_ROW_LIMIT);
        const sellers = await this.r.sellerModel.find({ _id: { $in: top.map((r) => r.sellerId) } }).select('name email').lean();
        const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));
        return toCsv(
          ['Seller ID', 'Name', 'Email', 'Order Count', 'Units Sold', 'Gross Revenue', 'Refunded', 'Net Revenue'],
          top.map((r) => [r.sellerId, sellerMap.get(r.sellerId)?.name ?? 'Unknown', sellerMap.get(r.sellerId)?.email ?? '', r.orderCount, r.unitsSold, r.grossRevenue.toFixed(2), r.refundedAmount.toFixed(2), r.netRevenue.toFixed(2)]),
        );
      }
      case 'products': {
        const rows = await aggregateProductSales(this.r.orderModel, from, to, scope);
        rows.sort((a, b) => b.netRevenue - a.netRevenue);
        return toCsv(
          ['Product ID', 'Name', 'Order Count', 'Units Sold', 'Gross Revenue', 'Refunded', 'Net Revenue'],
          rows.slice(0, CSV_ROW_LIMIT).map((r) => [r.productId, r.name, r.orderCount, r.unitsSold, r.grossRevenue.toFixed(2), r.refundedAmount.toFixed(2), r.netRevenue.toFixed(2)]),
        );
      }
      case 'customers': {
        const allTime = await allTimeCustomerAggregate(this.r.orderModel, scope);
        allTime.sort((a, b) => b.lifetimeValue - a.lifetimeValue);
        const top = allTime.slice(0, CSV_ROW_LIMIT);
        const users = await this.r.userModel.find({ _id: { $in: top.map((c) => c.userId) } }).select('name email').lean();
        const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));
        return toCsv(
          ['Customer', 'Email', 'Total Orders', 'Lifetime Value'],
          top.map((c) => [userMap.get(c.userId)?.name ?? 'Unknown', userMap.get(c.userId)?.email ?? '', c.totalOrders, c.lifetimeValue.toFixed(2)]),
        );
      }
      case 'payments': {
        const breakdown = await this.getPaymentBreakdown(query);
        return toCsv(
          ['Payment Type', 'Order Count', 'Revenue'],
          breakdown.data.methodBreakdown.map((r: any) => [r.label, r.orderCount, r.revenue.toFixed(2)]),
        );
      }
      case 'platform': {
        const metrics = await this.getPlatformMetrics(query);
        return toCsv(
          ['Date', 'New Sellers', 'New Stores', 'New Products'],
          metrics.data.marketplaceGrowth.map((s: any) => [new Date(s.date).toISOString().split('T')[0], s.newSellers, s.newStores, s.newProducts]),
        );
      }
      case 'revenue':
      default: {
        const revenueData = await this.getRevenueOverTime(query);
        return toCsv(
          ['Date', 'Gross Revenue', 'Net Revenue'],
          revenueData.data.series.map((s: any) => [new Date(s.date).toISOString().split('T')[0], s.grossRevenue.toFixed(2), s.netRevenue.toFixed(2)]),
        );
      }
    }
  }

  async exportPdf(query: any): Promise<Buffer> {
    const { from, to } = resolveDateRange(query);

    const [overview, revenue, topSellers, topProducts] = await Promise.all([
      this.getOverview(query),
      this.getRevenueOverTime(query),
      this.getTopSellers({ ...query, limit: 10 }),
      this.getTopProducts({ ...query, limit: 10 }),
    ]);

    const rangeLabel = `${from.toISOString().split('T')[0]} to ${to.toISOString().split('T')[0]}`;
    const pdf = await PdfReportBuilder.create('Edudeen — Platform Analytics Report', `Period: ${rangeLabel}`);

    pdf.addSectionHeading('Overview');
    pdf.addKeyValueGrid([
      { label: 'Total GMV', value: `$${overview.data.totalGMV.toFixed(2)}` },
      { label: 'Total Revenue (net)', value: `$${overview.data.totalRevenue.toFixed(2)}` },
      { label: 'Platform Earnings', value: `$${overview.data.platformEarnings.toFixed(2)}` },
      { label: 'Total Orders', value: `${overview.data.totalOrders}` },
      { label: 'Seller Accounts', value: `${overview.data.totalSellers}` },
      { label: 'Sellers Active This Month', value: `${overview.data.sellersActiveThisMonth}` },
      { label: 'Total Stores', value: `${overview.data.totalStores}` },
      { label: 'Active Stores', value: `${overview.data.activeStores}` },
      { label: 'Total Customers', value: `${overview.data.totalCustomers}` },
      { label: 'New Users', value: `${overview.data.newUsers}` },
      { label: 'Refund Rate', value: `${overview.data.refundRatePercent}%` },
      { label: 'Cancelled Orders', value: `${overview.data.cancelledOrders}` },
    ]);

    pdf.addSectionHeading('Revenue Over Time');
    if (revenue.data.series.length > 0) {
      pdf.addTable(
        ['Date', 'Gross', 'Net'],
        revenue.data.series.map((s: any) => [new Date(s.date).toISOString().split('T')[0], `$${s.grossRevenue.toFixed(2)}`, `$${s.netRevenue.toFixed(2)}`]),
      );
    } else {
      pdf.addEmptyNote('No revenue recorded in this period.');
    }

    pdf.addSectionHeading('Top Sellers');
    if (topSellers.data.length > 0) {
      pdf.addTable(
        ['Seller', 'Orders', 'Units', 'Revenue'],
        topSellers.data.map((s: any) => [s.name, s.orderCount, s.unitsSold, `$${s.revenue.toFixed(2)}`]),
      );
    } else {
      pdf.addEmptyNote('No seller sales recorded in this period.');
    }

    pdf.addSectionHeading('Top Products');
    if (topProducts.data.length > 0) {
      pdf.addTable(
        ['Product', 'Orders', 'Units', 'Revenue'],
        topProducts.data.map((p: any) => [p.name, p.orderCount, p.unitsSold, `$${p.revenue.toFixed(2)}`]),
      );
    } else {
      pdf.addEmptyNote('No product sales recorded in this period.');
    }

    return pdf.build();
  }
}
