/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from './analytics-number.util';
import { sellerOrderMatchStage } from './order-aggregation.util';

/**
 * Per-product sales for ONE store, built on the same booked rule as `sellerOverviewStats`:
 * booked = non-cancelled, non-free-claim package. A package's `subtotal` is split over its items by
 * item `totalPrice` (equal split when items carry no price), so the sum of every product's revenue is
 * exactly the overview's "Order value (booked)" for the same range. Free claims are only counted separately.
 * Currency: orders of a store share the store currency, same as the overview (no conversion).
 */
export interface ProductSalesRow {
  productId: string | null;
  orders: number;          // booked (non-free) packages containing the product
  trackedOrders: number;   // same, but only from the first tracked visit day (for conversion)
  revenue: number;         // raw, unrounded
  freeClaims: number;
}

export async function productSalesRows(orderModel: Model<any>, from: Date, to: Date, scopeMatch: Record<string, any>, trackingFrom: Date | null): Promise<{ rows: ProductSalesRow[]; totalRevenue: number }> {
  const raw = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
    {
      $addFields: {
        isClaim: { $eq: ['$isFreeClaim', true] },
        itemsSum: { $sum: '$sellerOrders.items.totalPrice' },
        nItems: { $size: { $ifNull: ['$sellerOrders.items', []] } },
        tracked: trackingFrom ? { $gte: ['$createdAt', trackingFrom] } : false,
      },
    },
    { $unwind: { path: '$sellerOrders.items', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        share: {
          $cond: [
            '$isClaim', 0,
            { $cond: [
              { $gt: ['$itemsSum', 0] },
              { $multiply: ['$sellerOrders.subtotal', { $divide: [{ $ifNull: ['$sellerOrders.items.totalPrice', 0] }, '$itemsSum'] }] },
              { $divide: ['$sellerOrders.subtotal', { $max: ['$nItems', 1] }] },
            ] },
          ],
        },
      },
    },
    // one row per (product, package): a package holding two variants of a product still counts once
    { $group: { _id: { p: '$sellerOrders.items.productId', o: '$_id' }, share: { $sum: '$share' }, isClaim: { $first: '$isClaim' }, tracked: { $first: '$tracked' } } },
    {
      $group: {
        _id: '$_id.p',
        orders: { $sum: { $cond: ['$isClaim', 0, 1] } },
        trackedOrders: { $sum: { $cond: [{ $and: [{ $not: ['$isClaim'] }, '$tracked'] }, 1, 0] } },
        revenue: { $sum: '$share' },
        freeClaims: { $sum: { $cond: ['$isClaim', 1, 0] } },
      },
    },
  ]);
  let total = 0;
  const rows: ProductSalesRow[] = raw.map((r: any) => {
    total += r.revenue;
    return { productId: r._id ? String(r._id) : null, orders: r.orders, trackedOrders: r.trackedOrders, revenue: r.revenue, freeClaims: r.freeClaims };
  });
  return { rows, totalRevenue: round(total) };
}

export const FREE_TO_PAID_WINDOWS = [7, 30, 90] as const;
const DAY_MS = 86400000;

/**
 * Free -> Paid: of the buyers whose FIRST free claim in this store fell inside [from, to], the share who
 * placed a paid, non-free, non-cancelled order in this store within `days` AFTER that first claim.
 * Someone who paid before claiming does not count. Only claimers whose window has fully closed are in the
 * percentage (a claim from 3 days ago cannot have had 30 days yet); the rest are reported as `pending`.
 */
export async function freeToPaid(orderModel: Model<any>, from: Date, to: Date, scopeMatch: Record<string, any>, days: number, now: Date = new Date()) {
  const claims = await orderModel.aggregate([
    { $match: { isDelete: false, isFreeClaim: true } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    { $group: { _id: '$userId', first: { $min: '$createdAt' } } },
  ]);
  const cohort = claims.filter((c: any) => c.first >= from && c.first <= to);
  if (!cohort.length) return { days, claimers: 0, matured: 0, pending: 0, converted: 0, percent: null as number | null };

  const firstBy = new Map<string, Date>(cohort.map((c: any) => [String(c._id), c.first as Date]));
  const earliest = new Date(Math.min(...cohort.map((c: any) => (c.first as Date).getTime())));
  const paid = await orderModel.aggregate([
    { $match: { isDelete: false, userId: { $in: [...firstBy.keys()] }, isFreeClaim: { $ne: true }, createdAt: { $gt: earliest } } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, $or: [{ isPaid: true }, { 'sellerOrders.isPaid': true }], ...scopeMatch } },
    { $group: { _id: '$userId', at: { $push: '$createdAt' } } },
  ]);
  const paidAt = new Map<string, Date[]>(paid.map((p: any) => [String(p._id), p.at as Date[]]));

  let matured = 0, converted = 0;
  for (const [uid, first] of firstBy) {
    const end = first.getTime() + days * DAY_MS;
    if (end > now.getTime()) continue; // window still open
    matured++;
    if ((paidAt.get(uid) ?? []).some((t) => t.getTime() > first.getTime() && t.getTime() <= end)) converted++;
  }
  return {
    days,
    claimers: cohort.length,
    matured,
    pending: cohort.length - matured,
    converted,
    percent: matured > 0 ? round((converted / matured) * 100) : null,
  };
}

export type ProductType = 'physical' | 'digital' | 'course';
/** Legacy 'educational' (and anything unknown) = digital. */
export function productTypeOf(p: { productType?: string; deliveryFormat?: string }): ProductType {
  if (p.deliveryFormat === 'course') return 'course';
  return p.productType === 'physical' ? 'physical' : 'digital';
}

export const PRODUCT_TABLE_SORTS = ['revenue', 'orders', 'views', 'conversion', 'claims', 'name'] as const;
