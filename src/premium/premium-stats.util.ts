/* eslint-disable prettier/prettier */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Seller-side Premium analytics: how many Edudeen Premium members' orders this store got and how much member-price
 * discount the STORE gave (seller-funded, already reflected in what the seller is credited) and how much the PLATFORM funded (platformFundedDiscount, reimbursed to the seller). Amounts are in the
 * order's own currency, so they are grouped per currency (a store can have PKR bank-transfer and USD card orders).
 */
export async function storePremiumStats(orderModel: any, storeId: string, from?: Date) {
  const match: Record<string, any> = { isDelete: false, isPremiumOrder: true, 'sellerOrders.storeId': storeId };
  if (from) match.createdAt = { $gte: from };
  const rows: any[] = await orderModel.aggregate([
    { $match: match },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.storeId': storeId } },
    { $group: {
        _id: { id: '$_id', currency: '$currency' },
        discount: { $sum: { $sum: '$sellerOrders.items.premiumDiscountUSD' } },
        platformFunded: { $sum: { $sum: '$sellerOrders.items.premiumPlatformDiscountUSD' } },
        total: { $sum: '$sellerOrders.subtotal' },
    } },
    { $group: { _id: '$_id.currency', orders: { $sum: 1 }, premiumDiscountGiven: { $sum: '$discount' }, platformFundedDiscount: { $sum: '$platformFunded' }, revenue: { $sum: '$total' } } },
  ]);
  return {
    premiumOrders: rows.reduce((s, r) => s + r.orders, 0),
    byCurrency: rows.map((r) => ({ currency: r._id, orders: r.orders, premiumDiscountGiven: round2(r.premiumDiscountGiven), platformFundedDiscount: round2(r.platformFundedDiscount ?? 0), revenue: round2(r.revenue) })),
  };
}
