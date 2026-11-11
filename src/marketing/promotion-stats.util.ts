/* eslint-disable prettier/prettier */
export type PromotionKind = 'coupon' | 'discount' | 'sale';

export interface PromotionStatRow {
  kind: PromotionKind;
  id: string;
  /** distinct orders that used it (one order = one use, even with several lines) */
  uses: number;
  /** this store's packages that used it (revenue basis) */
  orders: number;
  /** sum of the stored per-line discount amounts (already in the store currency) */
  discount: number;
  /** sum of THIS store's package subtotals (never the whole multi-store order) */
  revenue: number;
}

const DEAD = ['cancelled', 'refunded'];

/**
 * Read-only: per coupon / automatic discount / platform sale of ONE store, between from..to.
 * - Only this store's packages (sellerOrders.storeId) - other stores' packages of a multi-store order are ignored.
 * - Excludes free claims, orders marked refunded, cancelled/refunded packages and lines.
 * - Coupons: item.couponId (new orders). Older orders have no couponId, so a line with a coupon discount
 *   is matched through order.couponCode against this store's coupon codes (`couponIdsByCode`).
 * - Amounts are summed as stored on the order (already in the store currency, see payment createOrder).
 */
export async function promotionStats(
  orderModel: { aggregate: (p: any[]) => Promise<any[]> },
  storeId: string,
  from: Date,
  to: Date,
  couponIdsByCode: Record<string, string> = {},
): Promise<PromotionStatRow[]> {
  const codes = Object.keys(couponIdsByCode);
  const ids = codes.map((c) => couponIdsByCode[c]);
  const rows = await orderModel.aggregate([
    {
      $match: {
        isDelete: false,
        isFreeClaim: { $ne: true },
        paymentStatus: { $ne: 'refunded' },
        createdAt: { $gte: from, $lte: to },
        'sellerOrders.storeId': storeId,
      },
    },
    { $unwind: { path: '$sellerOrders', includeArrayIndex: 'pkg' } },
    { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.status': { $nin: DEAD } } },
    { $unwind: '$sellerOrders.items' },
    { $match: { 'sellerOrders.items.status': { $nin: DEAD } } },
    {
      $project: {
        orderId: '$_id',
        pkg: 1,
        subtotal: { $ifNull: ['$sellerOrders.subtotal', 0] },
        keys: {
          $filter: {
            input: [
              {
                kind: 'coupon',
                amount: { $ifNull: ['$sellerOrders.items.couponDiscountUSD', 0] },
                id: {
                  $cond: [
                    { $gt: [{ $ifNull: ['$sellerOrders.items.couponDiscountUSD', 0] }, 0] },
                    {
                      $ifNull: [
                        '$sellerOrders.items.couponId',
                        codes.length
                          ? {
                              $let: {
                                vars: { ix: { $indexOfArray: [codes, { $ifNull: ['$couponCode', ''] }] } },
                                in: { $cond: [{ $gte: ['$$ix', 0] }, { $arrayElemAt: [ids, '$$ix'] }, null] },
                              },
                            }
                          : null,
                      ],
                    },
                    null,
                  ],
                },
              },
              {
                kind: 'discount',
                amount: { $ifNull: ['$sellerOrders.items.autoDiscountUSD', 0] },
                id: {
                  $cond: [{ $gt: [{ $ifNull: ['$sellerOrders.items.autoDiscountUSD', 0] }, 0] }, '$sellerOrders.items.autoDiscountId', null],
                },
              },
              {
                kind: 'sale',
                amount: { $ifNull: ['$sellerOrders.items.campaignDiscountUSD', 0] },
                id: {
                  $cond: [{ $gt: [{ $ifNull: ['$sellerOrders.items.campaignDiscountUSD', 0] }, 0] }, '$sellerOrders.items.campaignId', null],
                },
              },
            ],
            as: 'k',
            cond: { $ne: ['$$k.id', null] },
          },
        },
      },
    },
    { $unwind: '$keys' },
    // one row per (promotion, order, package): a package with two discounted lines counts once
    {
      $group: {
        _id: { kind: '$keys.kind', id: '$keys.id', orderId: '$orderId', pkg: '$pkg' },
        discount: { $sum: '$keys.amount' },
        subtotal: { $first: '$subtotal' },
      },
    },
    {
      $group: {
        _id: { kind: '$_id.kind', id: '$_id.id' },
        orders: { $sum: 1 },
        orderIds: { $addToSet: '$_id.orderId' },
        discount: { $sum: '$discount' },
        revenue: { $sum: '$subtotal' },
      },
    },
  ]);
  const round2 = (n: number) => Math.round((n ?? 0) * 100) / 100;
  return rows.map((r: any) => ({
    kind: r._id.kind as PromotionKind,
    id: String(r._id.id),
    uses: (r.orderIds ?? []).length,
    orders: r.orders as number,
    discount: round2(r.discount),
    revenue: round2(r.revenue),
  }));
}
