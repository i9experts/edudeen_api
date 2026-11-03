/* eslint-disable prettier/prettier */
/** Admin courier settings (saved next to the rate table). Pure helpers, no DB. */
export type DeliveryCourierId = 'tcs' | 'leopards' | 'postex';
export const DELIVERY_COURIER_IDS: DeliveryCourierId[] = ['tcs', 'leopards', 'postex'];
export type DeliveryMethod = 'self' | DeliveryCourierId | 'auto';
export const DELIVERY_METHODS: DeliveryMethod[] = ['self', 'tcs', 'leopards', 'postex', 'auto'];

export interface CourierSettings {
  enabled: Record<DeliveryCourierId, boolean>;
  /** Ask the courier for a live rate at checkout (only works when its credentials are set). */
  useLiveRates: boolean;
  /** Added on top of a LIVE quote only. */
  markupPct: number;
  handlingFeePKR: number;
}

export const DEFAULT_COURIER_SETTINGS: CourierSettings = {
  enabled: { tcs: false, leopards: false, postex: false },
  useLiveRates: false,
  markupPct: 0,
  handlingFeePKR: 0,
};

const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Cleans admin input. Throws a readable message for out-of-range numbers (the UI validates too). */
export function sanitizeCourierSettings(input: any): CourierSettings {
  const checkRange = (v: unknown, min: number, max: number, label: string) => {
    if (v === undefined || v === null || v === '') return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be a number from ${min} to ${max}`);
  };
  checkRange(input?.markupPct, 0, 100, 'Markup %');
  checkRange(input?.handlingFeePKR, 0, 100_000, 'Handling fee');
  const enabled = {} as Record<DeliveryCourierId, boolean>;
  for (const id of DELIVERY_COURIER_IDS) enabled[id] = input?.enabled?.[id] === true;
  return {
    enabled,
    useLiveRates: input?.useLiveRates === true,
    markupPct: Math.round(num(input?.markupPct, 0, 100, 0) * 100) / 100,
    handlingFeePKR: Math.round(num(input?.handlingFeePKR, 0, 100_000, 0) * 100) / 100,
  };
}

/**
 * Master switch for courier delivery (TCS / Leopards / PostEx). OFF until the courier API credentials exist: set env
 * COURIER_DELIVERY_ENABLED=true to turn it on. While off, sellers can only choose 'self' (own delivery), any courier
 * method saved earlier is ignored (treated as unset = zone fee / slab table), and Edudeen never collects COD cash.
 */
export function courierDeliveryEnabled(): boolean {
  return process.env.COURIER_DELIVERY_ENABLED === 'true';
}

export function parseDeliveryMethod(v: unknown): DeliveryMethod | null {
  if (!DELIVERY_METHODS.includes(v as DeliveryMethod)) return null;
  if (v !== 'self' && !courierDeliveryEnabled()) return null;
  return v as DeliveryMethod;
}

export type CodCollector = 'seller' | 'platform';

/**
 * Who collects the COD cash of a store's package. Edudeen's courier (TCS/Leopards/PostEx) when the store chose one of
 * them (or 'auto') AND it is usable right now (admin-enabled + credentials set: `usable`); else the store's
 * admin-set fulfillmentMode ('platform' -> Edudeen) else the seller's own rider.
 */
export function resolveCodCollector(
  store: { deliveryMethod?: string | null; fulfillmentMode?: string | null } | null | undefined,
  usable: DeliveryCourierId[],
): CodCollector {
  const m = courierDeliveryEnabled() ? store?.deliveryMethod : null;
  const courierUsable = m === 'auto' ? usable.length > 0 : (m === 'tcs' || m === 'leopards' || m === 'postex') && usable.includes(m);
  if (courierUsable) return 'platform';
  return store?.fulfillmentMode === 'platform' ? 'platform' : 'seller';
}

/** Markup applies to live quotes only. */
export function applyMarkup(feePKR: number, s: Pick<CourierSettings, 'markupPct' | 'handlingFeePKR'>): number {
  return Math.round((feePKR * (1 + s.markupPct / 100) + s.handlingFeePKR) * 100) / 100;
}

/** 0.5 kg billable bucket used for the quote cache key. */
export function weightBucket(kg: number): number {
  return Math.max(0.5, Math.ceil(Math.max(kg, 0) / 0.5 - 1e-9) * 0.5);
}
