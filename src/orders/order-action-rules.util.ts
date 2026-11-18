/**
 * Buyer-facing cancel / refund eligibility, enforced in the API (the web only mirrors it to hide buttons).
 * Pure functions: return a clear message when the action must be rejected (400), or null when allowed.
 */
type Item = { name?: string; type?: string | null; status?: string | null; downloadCount?: number | null; totalPrice?: number | null };

/** Cancel: availed (free) orders, delivered orders and digital items that were already opened/downloaded are final. */
export function cancelBlockReason(
  order: { isFreeClaim?: boolean | null; orderStatus?: string | null },
  targetItems: Item[],
  actorRole?: 'seller' | 'admin',
): string | null {
  if (!actorRole && order.isFreeClaim) {
    return 'This free item is already in your library, so it cannot be cancelled.';
  }
  if (order.orderStatus === 'delivered') {
    return 'Delivered orders cannot be cancelled. You can request a return or refund instead.';
  }
  const opened = targetItems.find((i) => i.type === 'digital' && (i.downloadCount ?? 0) > 0);
  if (opened) {
    return `"${opened.name ?? 'This item'}" has already been opened or downloaded, so it cannot be cancelled.`;
  }
  return null;
}

/** Refund: an order or item that cost nothing has nothing to refund. */
export function refundBlockReason(
  order: { isFreeClaim?: boolean | null; totalAmount?: number | null },
  items: Item[],
): string | null {
  const itemsTotal = items.reduce((s, i) => s + (i.totalPrice ?? 0), 0);
  if (order.isFreeClaim || (!(order.totalAmount && order.totalAmount > 0)) || !(itemsTotal > 0)) {
    return 'This order was free (Rs 0), so there is nothing to refund.';
  }
  return null;
}
