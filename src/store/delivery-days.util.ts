import { BadRequestException } from '@nestjs/common';

/**
 * Seller-stated transit days per route (own city / same province / rest of Pakistan). DAYS ONLY - no fee logic.
 * Optional: a route that is not set is simply not shown to buyers. Whole days 0-30, min <= max.
 */
export type RouteKey = 'sameCity' | 'sameProvince' | 'national';
export type DayRange = { min: number; max: number };
export type DeliveryDays = Partial<Record<RouteKey, DayRange>>;

export const ROUTE_KEYS: RouteKey[] = ['sameCity', 'sameProvince', 'national'];
export const MAX_TRANSIT_DAYS = 30;

const ROUTE_LABEL: Record<RouteKey, string> = {
  sameCity: 'Own city',
  sameProvince: 'Same province',
  national: 'Rest of Pakistan',
};

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_TRANSIT_DAYS;

/** Validates a body value. null / {} / all routes empty -> null (clears). Unknown keys, decimals, > 30, min > max -> 400. */
export function cleanDeliveryDays(raw: unknown): DeliveryDays | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('deliveryDays must be an object');
  const out: DeliveryDays = {};
  for (const key of Object.keys(raw as object)) {
    if (!ROUTE_KEYS.includes(key as RouteKey)) throw new BadRequestException(`Unknown delivery route "${key}"`);
  }
  for (const key of ROUTE_KEYS) {
    const r = (raw as any)[key];
    if (r === undefined || r === null) continue;
    if (typeof r !== 'object' || Array.isArray(r)) throw new BadRequestException(`${ROUTE_LABEL[key]}: days must be an object with min and max`);
    const blank = (v: unknown) => v === undefined || v === null || v === '';
    if (blank(r.min) && blank(r.max)) continue; // row left empty = not set
    if (blank(r.min) || blank(r.max)) throw new BadRequestException(`${ROUTE_LABEL[key]}: enter both a minimum and a maximum number of days`);
    const min = typeof r.min === 'string' && r.min.trim() !== '' ? Number(r.min) : r.min;
    const max = typeof r.max === 'string' && r.max.trim() !== '' ? Number(r.max) : r.max;
    if (!isWhole(min) || !isWhole(max)) throw new BadRequestException(`${ROUTE_LABEL[key]}: days must be whole numbers from 0 to ${MAX_TRANSIT_DAYS}`);
    if (min > max) throw new BadRequestException(`${ROUTE_LABEL[key]}: the minimum cannot be more than the maximum`);
    out[key] = { min, max };
  }
  return Object.keys(out).length ? out : null;
}

/** The stored range for a route, or null when the seller did not set it (or the stored value is not valid). */
export function routeDaysFor(stored: unknown, route: RouteKey | null): DayRange | null {
  if (!route || !stored || typeof stored !== 'object') return null;
  const r = (stored as any)[route];
  if (!r || !isWhole(r.min) || !isWhole(r.max) || r.min > r.max) return null;
  return { min: r.min, max: r.max };
}
