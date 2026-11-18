/**
 * One rule for "this seller has set up Shipping" (delivery method, own delivery, or a ship-from city).
 * Used by the seller checklist and by the COD gate (checkout offer + PaymentService), so they can't drift.
 */
export interface StoreShippingFields {
  deliveryMethod?: string | null;
  deliverySettings?: { enabled?: boolean } | null;
  shipFrom?: { city?: string | null } | null;
}

export function isStoreShippingConfigured(store: StoreShippingFields | null | undefined): boolean {
  if (!store) return false;
  return !!store.deliveryMethod
    || store.deliverySettings?.enabled === true
    || !!String(store.shipFrom?.city ?? '').trim();
}

/** Select string for queries that feed isStoreShippingConfigured. */
export const STORE_SHIPPING_SELECT = 'deliveryMethod deliverySettings shipFrom';
