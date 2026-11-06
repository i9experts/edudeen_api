/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from './analytics-number.util';

/**
 * Shared `Order`/`sellerOrders` aggregation building blocks, used by both the
 * seller-scoped `AnalyticsService` and the platform-wide `AdminAnalyticsService`.
 *
 * Every function takes an optional `scopeMatch` — a Mongo match object applied
 * right after `$unwind: '$sellerOrders'`. Pass `{ 'sellerOrders.storeId': storeId }`
 * to scope to one store (seller analytics), `{ 'sellerOrders.sellerId': sellerId }`
 * to scope to one seller (admin drill-down), or omit it entirely for a platform-wide
 * aggregation across every seller/store (admin dashboards).
 *
 * Cancelled `sellerOrders` are excluded from every revenue/order metric — they
 * represent no completed business activity by convention (documented in the
 * seller analytics report this module was extracted from).
 */

export function notCancelledCond() {
  return { $ne: ['$sellerOrders.status', 'cancelled'] };
}

/** Sum of item-level refunds for the current sellerOrder — `$sum` over an array field works as an array accumulator outside `$group`. */
export function itemRefundSumField() {
  return { $sum: '$sellerOrders.items.refundedAmount' };
}

/**
 * Base match+unwind stage shared by every sellerOrder-level aggregation. There's no
 * top-level storeId/sellerId on `Order` — an order can span multiple sellers — so
 * scoping always happens after the unwind.
 *
 * Typed `any[]` (not `PipelineStage[]`) deliberately — these stages get spread into
 * hand-built aggregation arrays alongside further literal stages at each call site,
 * and Mongoose's `PipelineStage` discriminated union can't structurally verify a
 * dynamically-assembled pipeline. `any[]` matches this codebase's existing convention
 * of passing plain object literals straight to `.aggregate()` with no stage typing.
 */
export function sellerOrderMatchStage(from: Date, to: Date, scopeMatch?: Record<string, any>): any[] {
  const stages: any[] = [
    { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
    { $unwind: '$sellerOrders' },
  ];
  if (scopeMatch) stages.push({ $match: scopeMatch });
  return stages;
}

export interface PeriodTotals {
  orderCount: number;
  cancelledCount: number;
  refundedCount: number;
  grossRevenue: number;
  refundAmount: number;
  netRevenue: number;
  avgOrderValue: number;
  uniqueBuyerCount: number;
  buyerIds: string[];
}

/** Converts an amount between currencies (e.g. ExchangeRateService.convert). */
export type AmountConverter = (amount: number, fromCurrency: string) => Promise<number>;

/**
 * Totals for a period. Orders are stored in the currency the buyer paid in, so a
 * plain sum across orders mixes PKR and USD into one meaningless number. Pass a
 * `convert` (to the report's currency) and every currency bucket is converted
 * before summing; without it the old single-sum behaviour is kept (callers whose
 * scope is already single-currency). A currency that cannot be converted is left
 * out of the money totals and listed in `unconvertedCurrencies` — never summed
 * as if it were the report currency.
 */
export async function periodTotals(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>, convert?: AmountConverter): Promise<PeriodTotals & { unconvertedCurrencies: string[] }> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $addFields: { itemRefund: itemRefundSumField() } },
    {
      $group: {
        _id: convert ? '$currency' : null,
        orderCount: { $sum: { $cond: [notCancelledCond(), 1, 0] } },
        cancelledCount: { $sum: { $cond: [notCancelledCond(), 0, 1] } },
        refundedCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'refunded'] }, 1, 0] } },
        grossRevenue: { $sum: { $cond: [notCancelledCond(), '$sellerOrders.subtotal', 0] } },
        refundAmount: { $sum: { $cond: [notCancelledCond(), '$itemRefund', 0] } },
        buyerIds: { $addToSet: { $cond: [notCancelledCond(), '$userId', '$$REMOVE'] } },
      },
    },
  ]);

  let orderCount = 0, cancelledCount = 0, refundedCount = 0, grossRevenue = 0, refundAmount = 0;
  const buyers = new Set<string>();
  const unconvertedCurrencies: string[] = [];
  for (const row of rows) {
    orderCount += row.orderCount; cancelledCount += row.cancelledCount; refundedCount += row.refundedCount;
    for (const b of row.buyerIds ?? []) buyers.add(b);
    if (!convert) { grossRevenue += row.grossRevenue; refundAmount += row.refundAmount; continue; }
    const cur: string = row._id || 'USD';
    try {
      grossRevenue += await convert(row.grossRevenue, cur);
      refundAmount += await convert(row.refundAmount, cur);
    } catch {
      unconvertedCurrencies.push(cur);
    }
  }
  const netRevenue = round(grossRevenue - refundAmount);
  return {
    orderCount,
    cancelledCount,
    refundedCount,
    grossRevenue: round(grossRevenue),
    refundAmount: round(refundAmount),
    netRevenue,
    avgOrderValue: orderCount > 0 ? round(netRevenue / orderCount) : 0,
    uniqueBuyerCount: buyers.size,
    buyerIds: [...buyers],
    unconvertedCurrencies,
  };
}
/**
 * "Today" card only: PAID orders, free claims excluded (they are shown as a separate count).
 * Paid = order-level isPaid, or this package's own isPaid (multi-seller COD). Cancelled excluded.
 * Does not touch periodTotals, which Analytics/Finance keep using unchanged.
 */
export async function paidPeriodTotals(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>) {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
    { $addFields: { itemRefund: itemRefundSumField(), isClaim: { $eq: ['$isFreeClaim', true] }, paidNow: { $or: [{ $eq: ['$isPaid', true] }, { $eq: ['$sellerOrders.isPaid', true] }] } } },
    {
      $group: {
        _id: null,
        paidCount: { $sum: { $cond: [{ $and: [{ $not: ['$isClaim'] }, '$paidNow'] }, 1, 0] } },
        gross: { $sum: { $cond: [{ $and: [{ $not: ['$isClaim'] }, '$paidNow'] }, '$sellerOrders.subtotal', 0] } },
        refunds: { $sum: { $cond: [{ $and: [{ $not: ['$isClaim'] }, '$paidNow'] }, '$itemRefund', 0] } },
        freeClaims: { $sum: { $cond: ['$isClaim', 1, 0] } },
      },
    },
  ]);
  const r = rows[0] ?? { paidCount: 0, gross: 0, refunds: 0, freeClaims: 0 };
  const net = round(r.gross - r.refunds);
  return { orderCount: r.paidCount as number, netRevenue: net, avgOrderValue: r.paidCount > 0 ? round(net / r.paidCount) : 0, freeClaims: r.freeClaims as number };
}

/** Start of the Pakistan (UTC+5, no DST) calendar day that contains `d`. */
export function pktDayStart(d: Date): Date {
  const PKT = 5 * 3600 * 1000;
  const shifted = new Date(d.getTime() + PKT);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - PKT);
}

/**
 * ONE definition of customers for every seller metric (dashboard, Customers page, Analytics):
 * unique buyers = distinct users with a non-cancelled order in scope within [from, to];
 * repeat/returning = those buyers with >= 2 such orders in the same period; new = the rest.
 * repeat% = repeat / unique buyers, so new + returning always equals the unique-buyer count.
 */
/** Match for "real" orders: not cancelled, and (optionally) not a free claim. */
function liveOrderMatch(excludeFreeClaims?: boolean): Record<string, any> {
  return excludeFreeClaims
    ? { 'sellerOrders.status': { $ne: 'cancelled' }, isFreeClaim: { $ne: true } }
    : { 'sellerOrders.status': { $ne: 'cancelled' } };
}

/**
 * Seller Analytics Overview numbers. Free claims (Order.isFreeClaim) and cancelled packages are
 * never part of booked/paid figures; claims are only counted separately.
 * booked = non-cancelled, non-claim; paid = booked AND (order.isPaid OR package.isPaid) - the same
 * rule as paidPeriodTotals. AOV = booked value / booked count (same set).
 */
export async function sellerOverviewStats(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>) {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    {
      $addFields: {
        itemRefund: itemRefundSumField(),
        isClaim: { $eq: ['$isFreeClaim', true] },
        cancelled: { $eq: ['$sellerOrders.status', 'cancelled'] },
        paidNow: { $or: [{ $eq: ['$isPaid', true] }, { $eq: ['$sellerOrders.isPaid', true] }] },
      },
    },
    { $addFields: { booked: { $and: [{ $not: ['$cancelled'] }, { $not: ['$isClaim'] }] } } },
    {
      $group: {
        _id: null,
        bookedCount: { $sum: { $cond: ['$booked', 1, 0] } },
        bookedValue: { $sum: { $cond: ['$booked', '$sellerOrders.subtotal', 0] } },
        refunds: { $sum: { $cond: ['$booked', '$itemRefund', 0] } },
        paidCount: { $sum: { $cond: [{ $and: ['$booked', '$paidNow'] }, 1, 0] } },
        paidValue: { $sum: { $cond: [{ $and: ['$booked', '$paidNow'] }, '$sellerOrders.subtotal', 0] } },
        paidRefunds: { $sum: { $cond: [{ $and: ['$booked', '$paidNow'] }, '$itemRefund', 0] } },
        cancelledCount: { $sum: { $cond: [{ $and: ['$cancelled', { $not: ['$isClaim'] }] }, 1, 0] } },
        freeClaims: { $sum: { $cond: [{ $and: ['$isClaim', { $not: ['$cancelled'] }] }, 1, 0] } },
      },
    },
  ]);
  const r = rows[0] ?? {};
  const bookedCount: number = r.bookedCount ?? 0;
  const bookedValue = round(r.bookedValue ?? 0);
  const refunds = round(r.refunds ?? 0);
  return {
    bookedCount,
    bookedValue,
    avgOrderValue: bookedCount > 0 ? round(bookedValue / bookedCount) : 0,
    refunds,
    paidCount: (r.paidCount ?? 0) as number,
    collected: round((r.paidValue ?? 0) - (r.paidRefunds ?? 0)),
    cancelledCount: (r.cancelledCount ?? 0) as number,
    freeClaims: (r.freeClaims ?? 0) as number,
  };
}

/**
 * Overview customer split (free claims never count): unique buyers with a real order in [from, to];
 * new = their FIRST real order in scope falls inside the range, returning = they had an earlier one.
 * new(7d) is always a subset of new(30d) for the same end date.
 */
export async function customerSplit(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>): Promise<{ unique: number; newCustomers: number; returningCustomers: number }> {
  const opts = { excludeFreeClaims: true };
  const ids = await periodBuyerIds(orderModel, from, to, scopeMatch, opts);
  const earlier = await returningBuyerSet(orderModel, ids, from, scopeMatch, opts);
  const returningCustomers = ids.filter((id) => earlier.has(id)).length;
  return { unique: ids.length, newCustomers: ids.length - returningCustomers, returningCustomers };
}

export async function repeatBuyerStats(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>, opts?: { excludeFreeClaims?: boolean }): Promise<{ total: number; repeat: number; percent: number }> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: liveOrderMatch(opts?.excludeFreeClaims) },
    { $group: { _id: '$userId', orders: { $sum: 1 } } },
  ]);
  const total = rows.length;
  if (total === 0) return { total: 0, repeat: 0, percent: 0 };
  const repeat = rows.filter((r: any) => r.orders >= 2).length;
  return { total, repeat, percent: round((repeat / total) * 100) };
}
export async function repeatBuyerPercent(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>, opts?: { excludeFreeClaims?: boolean }): Promise<number> {
  return (await repeatBuyerStats(orderModel, from, to, scopeMatch, opts)).percent;
}
/** Distinct buyers with a non-cancelled order in scope within [from, to]. */
export async function periodBuyerIds(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>, opts?: { excludeFreeClaims?: boolean }): Promise<string[]> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: liveOrderMatch(opts?.excludeFreeClaims) },
    { $group: { _id: '$userId' } },
  ]);
  return rows.map((r: any) => r._id);
}
/** Buyers among `buyerIds` who already had a non-cancelled order (within `scopeMatch`'s scope) before `from`. */
export async function returningBuyerSet(orderModel: Model<any>, buyerIds: string[], from: Date, scopeMatch?: Record<string, any>, opts?: { excludeFreeClaims?: boolean }): Promise<Set<string>> {
  if (buyerIds.length === 0) return new Set();
  const rows = await orderModel.aggregate([
    { $match: { isDelete: false, userId: { $in: buyerIds }, createdAt: { $lt: from } } },
    { $unwind: '$sellerOrders' },
    { $match: { ...liveOrderMatch(opts?.excludeFreeClaims), ...scopeMatch } },
    { $group: { _id: '$userId' } },
  ]);
  return new Set(rows.map((r: any) => r._id));
}

export interface ProductSaleAggregate {
  productId: string;
  name: string;
  orderCount: number;
  unitsSold: number;
  grossRevenue: number;
  refundedAmount: number;
  netRevenue: number;
}

/** Shared item-level sales aggregation reused by top-products/product-performance on both the seller and admin sides. */
export async function aggregateProductSales(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>): Promise<ProductSaleAggregate[]> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
    { $unwind: '$sellerOrders.items' },
    {
      $group: {
        _id: '$sellerOrders.items.productId',
        name: { $first: '$sellerOrders.items.name' },
        orderCount: { $sum: 1 },
        unitsSold: { $sum: '$sellerOrders.items.quantity' },
        grossRevenue: { $sum: '$sellerOrders.items.totalPrice' },
        refundedAmount: { $sum: '$sellerOrders.items.refundedAmount' },
      },
    },
  ]);

  return rows.map((r: any) => ({
    productId: r._id,
    name: r.name,
    orderCount: r.orderCount,
    unitsSold: r.unitsSold,
    grossRevenue: round(r.grossRevenue),
    refundedAmount: round(r.refundedAmount),
    netRevenue: round(r.grossRevenue - r.refundedAmount),
  }));
}

export interface AllTimeCustomerAggregate {
  userId: string;
  firstOrderAt: Date;
  lastOrderAt: Date;
  totalOrders: number;
  lifetimeValue: number;
}

/** All-time per-customer aggregate (within `scopeMatch`'s scope) — the base for LTV, and for classifying new vs returning within any period. */
export async function allTimeCustomerAggregate(orderModel: Model<any>, scopeMatch?: Record<string, any>): Promise<AllTimeCustomerAggregate[]> {
  const rows = await orderModel.aggregate([
    { $match: { isDelete: false } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    { $addFields: { itemRefund: itemRefundSumField() } },
    {
      $group: {
        _id: '$userId',
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        totalOrders: { $sum: 1 },
        grossRevenue: { $sum: '$sellerOrders.subtotal' },
        refundAmount: { $sum: '$itemRefund' },
      },
    },
  ]);
  return rows.map((r: any) => ({
    userId: r._id,
    firstOrderAt: r.firstOrderAt as Date,
    lastOrderAt: r.lastOrderAt as Date,
    totalOrders: r.totalOrders,
    lifetimeValue: round(r.grossRevenue - r.refundAmount),
  }));
}
