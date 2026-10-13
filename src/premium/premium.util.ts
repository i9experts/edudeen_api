/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

export const DEFAULT_CHILDREN_LIMIT = 8;
export const PREMIUM_MIN_PERCENT = 1;
export const PREMIUM_MAX_PERCENT = 50;

export interface Entitlements {
  isPremium: boolean;
  childrenLimit: number;
  earlyAccessHours: number;
  prioritySupport: boolean;
}
export const NON_PREMIUM: Entitlements = { isPremium: false, childrenLimit: DEFAULT_CHILDREN_LIMIT, earlyAccessHours: 0, prioritySupport: false };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** End of a paid period: one calendar month / year after `from` (UTC), day clamped (Jan 31 + 1 month = Feb 28/29). */
export function addPeriod(from: Date, interval: 'monthly' | 'yearly'): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (interval === 'yearly' ? 12 : 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** The percent the seller gives premium members on a product: product override first, else the store setting. 0 = none. */
export function premiumPercentFor(product: { premiumDiscountPercent?: number | null } | null | undefined, store: { premiumDiscount?: { enabled?: boolean; percent?: number } | null } | null | undefined): number {
  const own = product?.premiumDiscountPercent;
  if (typeof own === 'number' && own >= PREMIUM_MIN_PERCENT && own <= PREMIUM_MAX_PERCENT) return own;
  const s = store?.premiumDiscount;
  if (s && s.enabled && typeof s.percent === 'number' && s.percent >= PREMIUM_MIN_PERCENT && s.percent <= PREMIUM_MAX_PERCENT) return s.percent;
  return 0;
}

/** Unit price after the member discount. */
export function premiumUnitPrice(listUnitPrice: number, percent: number): number {
  return round2(Math.max(0, listUnitPrice * (1 - percent / 100)));
}

/** Validates a seller-supplied per-product override. undefined = untouched, null = clear. */
export function cleanPremiumPercent(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < PREMIUM_MIN_PERCENT || n > PREMIUM_MAX_PERCENT) {
    throw new BadRequestException(`premiumDiscountPercent must be between ${PREMIUM_MIN_PERCENT} and ${PREMIUM_MAX_PERCENT}`);
  }
  return Math.round(n * 100) / 100;
}

/** Validates the store-level setting {enabled, percent}. undefined = untouched, null = clear. */
export function cleanStorePremiumDiscount(v: unknown): { enabled: boolean; percent: number } | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException('premiumDiscount must be an object { enabled, percent }');
  const o = v as { enabled?: unknown; percent?: unknown };
  const enabled = !!o.enabled;
  const n = Number(o.percent);
  if (!Number.isFinite(n) || n < PREMIUM_MIN_PERCENT || n > PREMIUM_MAX_PERCENT) {
    throw new BadRequestException(`premiumDiscount.percent must be between ${PREMIUM_MIN_PERCENT} and ${PREMIUM_MAX_PERCENT}`);
  }
  return { enabled, percent: Math.round(n * 100) / 100 };
}

/** 'YYYY-MM' (UTC) - the once-a-month coupon key. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Applies the seller-funded member price to one checkout line IN PLACE. Takes the best single seller-side
 * discount per line: lines already carrying a campaign or automatic discount are left alone, and a store
 * subscriber price is replaced only when the member price is strictly lower (never stacked).
 * Returns the discount given for the whole line (0 = not applied) and the subscriber discount it replaced.
 */
export function applyPremiumToLine(item: any, percent: number): { discount: number; replacedSubscriberDiscount: number } {
  const none = { discount: 0, replacedSubscriberDiscount: 0 };
  if (!(percent > 0)) return none;
  if ((item.campaignDiscountUSD ?? 0) > 0 || (item.autoDiscountUSD ?? 0) > 0) return none;
  const listUnit = item.originalPrice ?? item.price;
  const unit = premiumUnitPrice(listUnit, percent);
  if (!(unit < item.price)) return none; // the subscriber price is already as good or better
  const replaced = item.subscriberDiscountUSD ?? 0;
  const discount = round2((listUnit - unit) * item.quantity);
  item.originalPrice = listUnit;
  item.price = unit;
  item.totalPrice = round2(unit * item.quantity);
  item.subscriberDiscountUSD = 0;
  item.premiumDiscountUSD = discount;
  item.premiumDiscountPercent = percent;
  return { discount, replacedSubscriberDiscount: replaced };
}
