/**
 * Has the money for ONE package (sellerOrder) been collected?
 * Cash on delivery on a multi-seller order is paid package by package (SellerOrder.isPaid), so the order-level
 * flag alone is wrong for a 'partially_paid' order. Legacy / single-package orders carry no per-package flag and
 * simply use the order-level value, exactly as before.
 */
export function isPackagePaid(order: { isPaid?: boolean | null } | null | undefined, sellerOrder: { isPaid?: boolean | null } | null | undefined): boolean {
  return !!order?.isPaid || sellerOrder?.isPaid === true;
}
