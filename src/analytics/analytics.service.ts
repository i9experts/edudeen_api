/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import {
  BucketGranularity,
  absoluteChange,
  enumerateBuckets,
  nextBucket as nextBucketUtil,
  percentChange,
  resolveDateRange,
  trendFor,
} from './utils/analytics-date.util';
import { round } from './utils/analytics-number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from './utils/analytics-cache.util';
import {
  aggregateProductSales as aggregateProductSalesUtil,
  allTimeCustomerAggregate as allTimeCustomerAggregateUtil,
  itemRefundSumField,
  notCancelledCond,
  periodTotals as periodTotalsUtil,
  repeatBuyerPercent as repeatBuyerPercentUtil,
  returningBuyerSet as returningBuyerSetUtil,
  sellerOrderMatchStage,
} from './utils/order-aggregation.util';
import { toCsv } from './utils/csv.util';
import { PdfReportBuilder } from './utils/pdf-report.util';

import { clampInt } from 'src/common/query-safety.util';
const ATTRIBUTION_SOURCES = ['marketplace_search', 'direct_link', 'social_media', 'email', 'other'] as const;
const CACHE_TTL_SECONDS = 600; // 10 minutes

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private round(n: number) {
    return round(n);
  }

  // ─── Ownership + scope + caching ───────────────────────────────────────
  // Every seller analytics method below (except `today` and export/PDF, which
  // stay single-store) accepts `storeId: string | null | undefined` — a real
  // id scopes to that one store (ownership verified); omitting it scopes
  // across every store the seller owns instead, powering the cross-store
  // seller dashboard/analytics view with the exact same aggregation logic.

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    return verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
  }

  private async getOwnedStoreIds(sellerId: string): Promise<string[]> {
    const stores = await this.r.storeModel.find({ sellerId, isDelete: false }).select('_id').lean();
    return stores.map((s: any) => s._id.toString());
  }

  /** Resolves the `sellerOrders.storeId` match for either one verified store or every store the seller owns. */
  private async resolveScope(sellerId: string, storeId?: string | null): Promise<{ scope: Record<string, any>; storeIds: string[] }> {
    if (storeId) {
      await this.verifyStoreOwnership(storeId, sellerId);
      return { scope: { 'sellerOrders.storeId': storeId }, storeIds: [storeId] };
    }
    const storeIds = await this.getOwnedStoreIds(sellerId);
    return { scope: { 'sellerOrders.storeId': { $in: storeIds } }, storeIds };
  }

  /** Every revenue/order-value figure below is denominated in each order's own
   *  `Order.currency`, which is fixed per store (Store.baseCurrency). A single-
   *  store scope is always unambiguous. A cross-store ("all stores") scope is
   *  too UNLESS the seller happens to run stores in more than one currency —
   *  in that case a blended sum would silently mix PKR and USD into one
   *  meaningless number, so this resolves to `null` instead and callers must
   *  not label the aggregate with any one currency's symbol. */
  private async resolveScopeCurrency(storeIds: string[]): Promise<string | null> {
    if (storeIds.length === 0) return null;
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('baseCurrency').lean();
    const currencies = new Set(stores.map((s: any) => s.baseCurrency ?? 'PKR'));
    return currencies.size === 1 ? [...currencies][0] : null;
  }

  private async cached<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    return withAnalyticsCache(this.redis, cacheKey, CACHE_TTL_SECONDS, compute);
  }

  /** `scopeLabel` is the real storeId for a single-store call, or `seller:<sellerId>` for the cross-store one — keeps their cache entries distinct. */
  private key(section: string, scopeLabel: string, query: Record<string, any>) {
    return buildAnalyticsCacheKey('analytics', scopeLabel, section, query);
  }

  private scopeLabel(sellerId: string, storeId?: string | null) {
    return storeId ?? `seller:${sellerId}`;
  }

  // ─── Shared aggregation building blocks ────────────────────────────────
  // Every seller-scoped Order aggregation starts the same way: unwind the
  // embedded `sellerOrders` array (there's no top-level storeId on Order —
  // an order can span multiple sellers) and match the resolved scope.
  // Cancelled sellerOrders are excluded from every revenue/order metric —
  // they represent no completed business activity by convention. This
  // scoping logic (and the aggregations below) is shared with
  // `AdminAnalyticsService` via `./utils/order-aggregation.util`.

  private matchStage(scope: Record<string, any>, from: Date, to: Date) {
    return sellerOrderMatchStage(from, to, scope);
  }

  private notCancelled() {
    return notCancelledCond();
  }

  /** Sum of item-level refunds for the current sellerOrder — `$sum` over an array field works as an array accumulator outside `$group`. */
  private itemRefundField() {
    return itemRefundSumField();
  }

  private async periodTotals(scope: Record<string, any>, from: Date, to: Date) {
    return periodTotalsUtil(this.r.orderModel, from, to, scope);
  }

  private async repeatBuyerPercent(scope: Record<string, any>, from: Date, to: Date): Promise<number> {
    return repeatBuyerPercentUtil(this.r.orderModel, from, to, scope);
  }

  /** Buyers among `buyerIds` who already had a non-cancelled order within this scope before `from`. */
  private async returningBuyerSet(scope: Record<string, any>, buyerIds: string[], from: Date): Promise<Set<string>> {
    return returningBuyerSetUtil(this.r.orderModel, buyerIds, from, scope);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TODAY SUMMARY — store dashboard's "Today's Revenue" live card. Compares
  // today-so-far against the *same elapsed window* yesterday (not all of
  // yesterday) so the percent change is apples-to-apples regardless of what
  // time of day it's checked. Deliberately omits "visitors"/"conversion
  // rate" — there is no storefront visit/session tracking anywhere in this
  // codebase to compute them from (see subscriptions.service.ts's identical
  // disclaimer for subscriber conversion rate); inventing those numbers
  // would violate the app's "no fake data" rule, so the app hides those
  // stat cells instead of receiving placeholder values. Single-store only —
  // this is the per-store dashboard's widget, not the cross-store one.
  // ═══════════════════════════════════════════════════════════════════════

  private readonly TODAY_CACHE_TTL_SECONDS = 30; // short — card is labeled "Live"

  async getTodaySummary(sellerId: string, storeIdInput: string | null | undefined) {
    const storeId = this.requireStoreId(storeIdInput);
    await this.verifyStoreOwnership(storeId, sellerId);
    const scope = { 'sellerOrders.storeId': storeId };

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const elapsedMs = now.getTime() - todayStart.getTime();
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdaySameTime = new Date(yesterdayStart.getTime() + elapsedMs);

    return withAnalyticsCache(this.redis, this.key('today', storeId, {}), this.TODAY_CACHE_TTL_SECONDS, async () => {
      const [today, yesterday] = await Promise.all([
        this.periodTotals(scope, todayStart, now),
        this.periodTotals(scope, yesterdayStart, yesterdaySameTime),
      ]);

      return {
        success: true,
        data: {
          revenue: today.netRevenue,
          revenueChangePercent: percentChange(today.netRevenue, yesterday.netRevenue),
          ordersCount: today.orderCount,
          avgOrderValue: today.avgOrderValue,
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds } = await this.resolveScope(sellerId, storeId);
    const { from, to, previousFrom, previousTo } = resolveDateRange(query);
    const compare = query.compareToPreviousPeriod === true || query.compareToPreviousPeriod === 'true';

    return this.cached(this.key('overview', this.scopeLabel(sellerId, storeId), { from, to, compare }), async () => {
      const [current, previous, repeatBuyerPct, prevRepeatBuyerPct, currency] = await Promise.all([
        this.periodTotals(scope, from, to),
        this.periodTotals(scope, previousFrom, previousTo),
        this.repeatBuyerPercent(scope, from, to),
        this.repeatBuyerPercent(scope, previousFrom, previousTo),
        this.resolveScopeCurrency(storeIds),
      ]);

      const returningSet = await this.returningBuyerSet(scope, current.buyerIds, from);
      const newCustomersCount = current.uniqueBuyerCount - returningSet.size;
      const returningCustomersCount = returningSet.size;

      const refundRatePercent = current.grossRevenue > 0 ? this.round((current.refundAmount / current.grossRevenue) * 100) : 0;

      const data: Record<string, any> = {
        period: { from, to },
        storeCount: storeIds.length,
        currency,
        grossRevenue: current.grossRevenue,
        totalRevenue: current.netRevenue, // "totalRevenue" = net of refunds, per spec
        totalRevenueChangePercent: percentChange(current.netRevenue, previous.netRevenue),
        totalOrders: current.orderCount,
        totalOrdersChange: absoluteChange(current.orderCount, previous.orderCount),
        avgOrderValue: current.avgOrderValue,
        avgOrderValueChangePercent: percentChange(current.avgOrderValue, previous.avgOrderValue),
        repeatBuyerPercent: repeatBuyerPct,
        repeatBuyerTrend: trendFor(repeatBuyerPct, prevRepeatBuyerPct),
        totalRefunds: current.refundAmount,
        refundRatePercent,
        cancelledOrders: current.cancelledCount,
        newCustomersCount,
        returningCustomersCount,
      };

      if (compare) {
        data.previousPeriod = {
          period: { from: previousFrom, to: previousTo },
          grossRevenue: previous.grossRevenue,
          totalRevenue: previous.netRevenue,
          totalOrders: previous.orderCount,
          avgOrderValue: previous.avgOrderValue,
          repeatBuyerPercent: prevRepeatBuyerPct,
          totalRefunds: previous.refundAmount,
          cancelledOrders: previous.cancelledCount,
        };
      }

      return { success: true, data };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. REVENUE OVER TIME
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueOverTime(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds } = await this.resolveScope(sellerId, storeId);
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('revenue-over-time', this.scopeLabel(sellerId, storeId), { from, to }), async () => {
      const currency = await this.resolveScopeCurrency(storeIds);
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        {
          $addFields: {
            itemRefund: this.itemRefundField(),
            bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } },
          },
        },
        {
          $group: {
            _id: '$bucket',
            grossRevenue: { $sum: { $cond: [this.notCancelled(), '$sellerOrders.subtotal', 0] } },
            refundAmount: { $sum: { $cond: [this.notCancelled(), '$itemRefund', 0] } },
          },
        },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        const gross = this.round(row?.grossRevenue ?? 0);
        const refund = this.round(row?.refundAmount ?? 0);
        return { date: bucket, grossRevenue: gross, netRevenue: this.round(gross - refund) };
      });

      return { success: true, data: { granularity, currency, series } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. ORDERS OVER TIME
  // ═══════════════════════════════════════════════════════════════════════

  async getOrdersOverTime(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope } = await this.resolveScope(sellerId, storeId);
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('orders-over-time', this.scopeLabel(sellerId, storeId), { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        {
          $group: {
            _id: '$bucket',
            orderCount: { $sum: { $cond: [this.notCancelled(), 1, 0] } },
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

  // ═══════════════════════════════════════════════════════════════════════
  // D. TRAFFIC SOURCES
  // ═══════════════════════════════════════════════════════════════════════

  async getTrafficSources(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope } = await this.resolveScope(sellerId, storeId);
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('traffic-sources', this.scopeLabel(sellerId, storeId), { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        {
          $group: {
            _id: { $ifNull: ['$attributionSource', 'other'] },
            count: { $sum: 1 },
            revenue: { $sum: '$sellerOrders.subtotal' },
          },
        },
      ]);

      const bysource = new Map(rows.map((r: any) => [r._id, r]));
      const totalCount = rows.reduce((sum: number, r: any) => sum + r.count, 0);

      const breakdown = ATTRIBUTION_SOURCES.map((source) => {
        const row = bysource.get(source);
        const count = row?.count ?? 0;
        return {
          source,
          count,
          revenue: this.round(row?.revenue ?? 0),
          percent: totalCount > 0 ? this.round((count / totalCount) * 100) : 0,
        };
      });

      return { success: true, data: { total: totalCount, breakdown } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E. TOP PRODUCTS
  // ═══════════════════════════════════════════════════════════════════════

  async getTopProducts(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope } = await this.resolveScope(sellerId, storeId);
    const { from, to } = resolveDateRange(query);
    const limit = clampInt(query.limit, 10, 1, 100);
    const sort = query.sort === 'units_sold' ? 'units_sold' : 'revenue';

    return this.cached(this.key('top-products', this.scopeLabel(sellerId, storeId), { from, to, limit, sort }), async () => {
      const rows = await this.aggregateProductSales(scope, from, to);
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

  /** Shared item-level sales aggregation reused by top-products and product-performance (and by admin analytics, platform-wide). */
  private async aggregateProductSales(scope: Record<string, any>, from: Date, to: Date) {
    return aggregateProductSalesUtil(this.r.orderModel, from, to, scope);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. CUSTOMER ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  /** All-time per-customer aggregate for this scope — the base for LTV, and for classifying new vs returning within any period. */
  private async allTimeCustomerAggregate(scope: Record<string, any>) {
    return allTimeCustomerAggregateUtil(this.r.orderModel, scope);
  }

  async getCustomerAnalytics(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope } = await this.resolveScope(sellerId, storeId);
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('customers', this.scopeLabel(sellerId, storeId), { from, to }), async () => {
      const allTime = await this.allTimeCustomerAggregate(scope);
      const firstOrderMap = new Map(allTime.map((c) => [c.userId, c.firstOrderAt]));

      // New vs returning per bucket, using each buyer's all-time first order date within this scope.
      const periodRows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', userId: '$userId' } } },
      ]);

      const bucketTotals = new Map<number, { newCustomers: number; returningCustomers: number }>();
      for (const row of periodRows) {
        const bucketTime = row._id.bucket.getTime();
        const firstOrderAt = firstOrderMap.get(row._id.userId);
        // "New" in this bucket = their all-time first order within this scope falls within it.
        const isNew = !!firstOrderAt && firstOrderAt >= row._id.bucket && firstOrderAt < this.nextBucket(row._id.bucket, granularity);
        const entry = bucketTotals.get(bucketTime) ?? { newCustomers: 0, returningCustomers: 0 };
        if (isNew) entry.newCustomers += 1; else entry.returningCustomers += 1;
        bucketTotals.set(bucketTime, entry);
      }

      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const totals = bucketTotals.get(bucket.getTime()) ?? { newCustomers: 0, returningCustomers: 0 };
        return { date: bucket, ...totals };
      });

      // Lifetime value summary + top customers (all-time LTV within this scope).
      const avgLifetimeValue = allTime.length > 0
        ? this.round(allTime.reduce((sum, c) => sum + c.lifetimeValue, 0) / allTime.length)
        : 0;

      const topByLtv = [...allTime].sort((a, b) => b.lifetimeValue - a.lifetimeValue).slice(0, 10);
      const users = await this.r.userModel
        .find({ _id: { $in: topByLtv.map((c) => c.userId) } })
        .select('name email')
        .lean();
      const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

      const topCustomers = topByLtv.map((c) => ({
        userId: c.userId,
        name: userMap.get(c.userId)?.name ?? 'Unknown',
        email: userMap.get(c.userId)?.email ?? '',
        totalOrders: c.totalOrders,
        lifetimeValue: c.lifetimeValue,
      }));

      // Geographic breakdown — physical orders only (digital orders have no shippingAddress).
      const geoRows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, shippingAddress: { $ne: null } } },
        { $group: { _id: '$shippingAddress.state', orders: { $sum: 1 }, revenue: { $sum: '$sellerOrders.subtotal' } } },
        { $sort: { revenue: -1 } },
      ]);

      return {
        success: true,
        data: {
          granularity,
          newVsReturning: series,
          averageLifetimeValue: avgLifetimeValue,
          topCustomersByLtv: topCustomers,
          geographicBreakdown: geoRows.map((r: any) => ({
            state: r._id ?? 'Unknown',
            orders: r.orders,
            revenue: this.round(r.revenue),
          })),
        },
      };
    });
  }

  private nextBucket(bucket: Date, granularity: BucketGranularity): Date {
    return nextBucketUtil(bucket, granularity);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F2. PRODUCT PERFORMANCE (paginated, beyond top-N)
  // ═══════════════════════════════════════════════════════════════════════

  async getProductPerformance(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds } = await this.resolveScope(sellerId, storeId);
    const { from, to } = resolveDateRange(query);
    const page = clampInt(query.page, 1, 1, 100000);
    const limit = clampInt(query.limit, 20, 1, 100);

    return this.cached(this.key('product-performance', this.scopeLabel(sellerId, storeId), { from, to, page, limit }), async () => {
      const [sales, products] = await Promise.all([
        this.aggregateProductSales(scope, from, to),
        this.r.productModel.find({ storeId: { $in: storeIds }, isDelete: false }).select('name').lean(),
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
          refundRatePercent: sale && sale.grossRevenue > 0 ? this.round((refundedAmount / sale.grossRevenue) * 100) : 0,
          currentStock: stock,
          isLowPerformer: unitsSold === 0 && stock > 0,
        };
      });

      merged.sort((a, b) => b.revenue - a.revenue);
      const total = merged.length;
      const start = (page - 1) * limit;
      const pageItems = merged.slice(start, start + limit);

      return {
        success: true,
        data: {
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          products: pageItems,
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F3. INVENTORY INSIGHTS
  // ═══════════════════════════════════════════════════════════════════════

  async getInventoryInsights(sellerId: string, storeId: string | null | undefined) {
    const { scope, storeIds } = await this.resolveScope(sellerId, storeId);

    return this.cached(this.key('inventory-insights', this.scopeLabel(sellerId, storeId), {}), async () => {
      // Sell-through measured over the trailing 30 days — a fixed, well-understood window for a store-wide inventory snapshot (this endpoint has no range param).
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);

      const [products, sales30d] = await Promise.all([
        this.r.productModel.find({ storeId: { $in: storeIds }, isDelete: false, status: 'active' }).select('name').lean(),
        this.aggregateProductSales(scope, from, to),
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
        const sellThroughRate = unitsSold30d + stock > 0 ? this.round((unitsSold30d / (unitsSold30d + stock)) * 100) : 0;

        if (stock <= 0) {
          outOfStock.push({ productId: id, name: p.name, unitsSoldLast30Days: unitsSold30d });
          continue;
        }

        const entry = { productId: id, name: p.name, currentStock: stock, unitsSoldLast30Days: unitsSold30d, sellThroughRatePercent: sellThroughRate };
        if (sellThroughRate >= 50) fastMoving.push(entry);
        else if (unitsSold30d > 0) slowMoving.push(entry);

        // Simple reorder heuristic: selling faster than 2 weeks of stock remaining at the current 30-day pace.
        const weeklyRate = unitsSold30d / (30 / 7);
        if (weeklyRate > 0 && stock < weeklyRate * 2) {
          reorderSuggestions.push({ productId: id, name: p.name, currentStock: stock, estimatedWeeksRemaining: this.round(stock / weeklyRate) });
        }
      }

      fastMoving.sort((a, b) => b.sellThroughRatePercent - a.sellThroughRatePercent);
      slowMoving.sort((a, b) => a.sellThroughRatePercent - b.sellThroughRatePercent);

      return {
        success: true,
        data: {
          note: 'Sell-through and reorder suggestions are based on the trailing 30 days. Lost-sales-from-search cross-referencing is not available — this codebase has no search/view-event tracking to correlate against out-of-stock products.',
          outOfStock,
          fastMoving: fastMoving.slice(0, 20),
          slowMoving: slowMoving.slice(0, 20),
          reorderSuggestions: reorderSuggestions.slice(0, 20),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F4. PAYMENT METHOD BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════════

  async getPaymentMethods(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope } = await this.resolveScope(sellerId, storeId);
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('payment-methods', this.scopeLabel(sellerId, storeId), { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: '$paymentType', count: { $sum: 1 }, revenue: { $sum: '$sellerOrders.subtotal' } } },
      ]);

      const labels: Record<string, string> = { cash_on_delivery: 'Cash on Delivery', stripe: 'Card (Stripe)' };
      return {
        success: true,
        data: rows.map((r: any) => ({
          paymentType: r._id,
          label: labels[r._id] ?? r._id,
          orderCount: r.count,
          revenue: this.round(r.revenue),
        })),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F5. REVENUE BREAKDOWN — orders vs subscriptions
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueBreakdown(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope } = await this.resolveScope(sellerId, storeId);
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('revenue-breakdown', this.scopeLabel(sellerId, storeId), { from, to }), async () => {
      const orderTotals = await this.periodTotals(scope, from, to);

      // Subscription plans are seller-scoped, not store-scoped, in this codebase's data
      // model — so this figure is identical whether viewing one store or every store
      // (flagged explicitly rather than silently misattributed to a single store).
      const subRows = await this.r.subscriptionInvoiceModel.aggregate([
        { $match: { sellerId, status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]);
      const recurringRevenue = this.round(subRows[0]?.total ?? 0);

      return {
        success: true,
        data: {
          oneTimeOrderRevenue: orderTotals.netRevenue,
          recurringSubscriptionRevenue: recurringRevenue,
          totalRevenue: this.round(orderTotals.netRevenue + recurringRevenue),
          note: 'Subscription revenue is scoped to the seller (not one specific store) — this codebase\'s Subscription plans are not store-attributed.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // G. EXPORT — single-store only for now; not part of the cross-store view.
  // ═══════════════════════════════════════════════════════════════════════

  private requireStoreId(storeId: string | null | undefined): string {
    if (!storeId) throw new Error('storeId is required for export');
    return storeId;
  }

  async exportCsv(sellerId: string, storeIdInput: string | null | undefined, query: any): Promise<string> {
    const storeId = this.requireStoreId(storeIdInput);
    await this.verifyStoreOwnership(storeId, sellerId);
    const scope = { 'sellerOrders.storeId': storeId };
    const { from, to } = resolveDateRange(query);
    const section = query.section ?? 'revenue';

    switch (section) {
      case 'orders': {
        const rows = await this.r.orderModel.aggregate([
          ...this.matchStage(scope, from, to),
          { $project: { _id: 0, orderNumber: 1, createdAt: 1, status: '$sellerOrders.status', subtotal: '$sellerOrders.subtotal', paymentType: 1 } },
          { $sort: { createdAt: -1 } },
          { $limit: 5000 },
        ]);
        return toCsv(
          ['Order Number', 'Date', 'Status', 'Subtotal', 'Payment Type'],
          rows.map((r: any) => [r.orderNumber, new Date(r.createdAt).toISOString().split('T')[0], r.status, r.subtotal.toFixed(2), r.paymentType ?? '']),
        );
      }
      case 'products': {
        const rows = await this.aggregateProductSales(scope, from, to);
        rows.sort((a, b) => b.netRevenue - a.netRevenue);
        return toCsv(
          ['Product ID', 'Name', 'Order Count', 'Units Sold', 'Gross Revenue', 'Refunded', 'Net Revenue'],
          rows.map((r) => [r.productId, r.name, r.orderCount, r.unitsSold, r.grossRevenue.toFixed(2), r.refundedAmount.toFixed(2), r.netRevenue.toFixed(2)]),
        );
      }
      case 'customers': {
        const allTime = await this.allTimeCustomerAggregate(scope);
        const users = await this.r.userModel.find({ _id: { $in: allTime.map((c) => c.userId) } }).select('name email').lean();
        const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));
        return toCsv(
          ['Customer', 'Email', 'Total Orders', 'Lifetime Value'],
          allTime
            .sort((a, b) => b.lifetimeValue - a.lifetimeValue)
            .map((c) => [userMap.get(c.userId)?.name ?? 'Unknown', userMap.get(c.userId)?.email ?? '', c.totalOrders, c.lifetimeValue.toFixed(2)]),
        );
      }
      case 'revenue':
      default: {
        const revenueData = await this.getRevenueOverTime(sellerId, storeId, query);
        return toCsv(
          ['Date', 'Gross Revenue', 'Net Revenue'],
          revenueData.data.series.map((s: any) => [new Date(s.date).toISOString().split('T')[0], s.grossRevenue.toFixed(2), s.netRevenue.toFixed(2)]),
        );
      }
    }
  }

  async exportPdf(sellerId: string, storeIdInput: string | null | undefined, query: any): Promise<Buffer> {
    const storeId = this.requireStoreId(storeIdInput);
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);

    const [overview, revenue, traffic, topProducts] = await Promise.all([
      this.getOverview(sellerId, storeId, query),
      this.getRevenueOverTime(sellerId, storeId, query),
      this.getTrafficSources(sellerId, storeId, query),
      this.getTopProducts(sellerId, storeId, { ...query, limit: 10 }),
    ]);

    const rangeLabel = `${from.toISOString().split('T')[0]} to ${to.toISOString().split('T')[0]}`;
    const pdf = await PdfReportBuilder.create(`${store.name} — Analytics Report`, `Period: ${rangeLabel}`);

    pdf.addSectionHeading('Overview');
    pdf.addKeyValueGrid([
      { label: 'Total Revenue (net)', value: `$${overview.data.totalRevenue.toFixed(2)}` },
      { label: 'Gross Revenue', value: `$${overview.data.grossRevenue.toFixed(2)}` },
      { label: 'Total Orders', value: `${overview.data.totalOrders}` },
      { label: 'Avg Order Value', value: `$${overview.data.avgOrderValue.toFixed(2)}` },
      { label: 'Repeat Buyers', value: `${overview.data.repeatBuyerPercent}%` },
      { label: 'Refund Rate', value: `${overview.data.refundRatePercent}%` },
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

    pdf.addSectionHeading('Traffic Sources');
    pdf.addTable(
      ['Source', 'Orders', 'Revenue', '%'],
      traffic.data.breakdown.map((b: any) => [b.source, b.count, `$${b.revenue.toFixed(2)}`, `${b.percent}%`]),
    );

    pdf.addSectionHeading('Top Products by Revenue');
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

  /**
   * Report-generation entry point for a future scheduled email job — reuses
   * the exact same aggregation as `exportPdf`. No cron/email wiring is added
   * here; `SchedulerModule` (`@nestjs/schedule`) and an OTP-only
   * `EmailService` already exist in this codebase but neither is wired to
   * this yet — see the analytics report for what a follow-up needs to do.
   */
  async generateScheduledReport(sellerId: string, storeId: string, range: string): Promise<Buffer> {
    return this.exportPdf(sellerId, storeId, { range });
  }
}
