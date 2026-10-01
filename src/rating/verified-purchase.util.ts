/**
 * The ONE definition of "this buyer really bought this product" — used to gate writing a review
 * (RatingService.addReview) and to tell the apps whether to offer one (`canReview` on order line items and on
 * product detail). Keeping a single implementation means what the UI offers can never drift from what the
 * API accepts.
 */
export const DELIVERED_ITEM_STATUSES = ['delivered', 'completed'];

/** Does this one order line count as a verified purchase? (the per-line half of the rule) */
export function isVerifiedPurchaseLine(
  order: { isPaid?: boolean | null },
  item: { type?: string | null; status?: string | null },
): boolean {
  // Physical goods: must actually have been delivered.
  if (DELIVERED_ITEM_STATUSES.includes(item.status ?? '')) return true;
  // Digital goods are delivered at payment (their item status is never moved to delivered/completed), so a
  // paid, non-refunded digital line is a real purchase.
  return item.type === 'digital' && !!order.isPaid && !['cancelled', 'refunded'].includes(item.status ?? '');
}

/**
 * Has `userId` verifiably bought `productId` (optionally a specific variant, optionally within one order)?
 * Checked in application code rather than a single Mongo query — sellerOrders and items are both arrays, so a
 * flat multi-field filter could match productId on one item and status on a different item of the same order.
 * The query itself is narrowed to orders that contain the product, which cannot change the answer.
 */
export async function checkVerifiedPurchase(
  orderModel: any,
  userId: string,
  productId: string,
  productVariantId: string | null,
  orderId?: string | null,
): Promise<boolean> {
  const filter: any = { userId, isDelete: false, 'sellerOrders.items.productId': productId };
  if (orderId) filter._id = orderId;

  const orders = await orderModel.find(filter).select('sellerOrders isPaid').lean();

  for (const order of orders) {
    for (const sellerOrder of order.sellerOrders || []) {
      for (const item of sellerOrder.items || []) {
        if (item.productId !== productId) continue;
        if (productVariantId && item.variantId !== productVariantId) continue;
        if (isVerifiedPurchaseLine(order, item)) return true;
      }
    }
  }
  return false;
}
