/* eslint-disable prettier/prettier */
/**
 * Weight-based delivery charge (TCS-style): price = slab for the billable weight in the route class
 * (same city / same province / rest of Pakistan), + fragile surcharge, + fuel %, + tax %.
 * All amounts are PKR. Pure functions, no DB. The admin edits the table; a live courier API can later
 * replace `quoteRate` behind the same signature.
 */

export type ParcelType = 'document' | 'standard' | 'fragile' | 'bulky';
export const PARCEL_TYPES: ParcelType[] = ['document', 'standard', 'fragile', 'bulky'];
export type RouteClass = 'sameCity' | 'sameProvince' | 'national';
export const ROUTE_CLASSES: RouteClass[] = ['sameCity', 'sameProvince', 'national'];

export interface RateSlab { upToKg: number; feePKR: number }
export interface RouteRate { slabs: RateSlab[]; extraPerKgPKR: number }
export interface RateTable {
  enabled: boolean;
  routes: Record<RouteClass, RouteRate>;
  fragileSurchargePKR: number;
  fuelSurchargePct: number;
  taxPct: number;
  /** cm^3 per kg; courier standard is 5000. */
  volumetricDivisor: number;
}

export interface Dimensions { l?: number | null; w?: number | null; h?: number | null }

export const DEFAULT_RATE_TABLE: RateTable = {
  enabled: false,
  routes: {
    sameCity: { slabs: [{ upToKg: 0.5, feePKR: 0 }, { upToKg: 1, feePKR: 0 }], extraPerKgPKR: 0 },
    sameProvince: { slabs: [{ upToKg: 0.5, feePKR: 0 }, { upToKg: 1, feePKR: 0 }], extraPerKgPKR: 0 },
    national: { slabs: [{ upToKg: 0.5, feePKR: 0 }, { upToKg: 1, feePKR: 0 }], extraPerKgPKR: 0 },
  },
  fragileSurchargePKR: 0,
  fuelSurchargePct: 0,
  taxPct: 0,
  volumetricDivisor: 5000,
};

const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Cleans admin input; throws a readable message on a clearly broken table (slabs out of order). */
export function sanitizeRateTable(input: any): RateTable {
  const base = DEFAULT_RATE_TABLE;
  const routes = {} as Record<RouteClass, RouteRate>;
  for (const rc of ROUTE_CLASSES) {
    const raw = input?.routes?.[rc];
    const slabsIn: any[] = Array.isArray(raw?.slabs) ? raw.slabs.slice(0, 12) : base.routes[rc].slabs;
    const slabs = slabsIn
      .map((s) => ({ upToKg: num(s?.upToKg, 0.001, 50, NaN), feePKR: num(s?.feePKR, 0, 1_000_000, NaN) }))
      .filter((s) => Number.isFinite(s.upToKg) && Number.isFinite(s.feePKR))
      .sort((a, b) => a.upToKg - b.upToKg);
    for (let i = 1; i < slabs.length; i++) {
      if (slabs[i].upToKg === slabs[i - 1].upToKg) throw new Error(`Two ${rc} slabs have the same weight limit`);
      if (slabs[i].feePKR < slabs[i - 1].feePKR) throw new Error(`${rc}: a heavier slab can't cost less than a lighter one`);
    }
    if (!slabs.length) throw new Error(`${rc} needs at least one weight slab`);
    routes[rc] = { slabs, extraPerKgPKR: num(raw?.extraPerKgPKR, 0, 100_000, 0) };
  }
  return {
    enabled: input?.enabled === true,
    routes,
    fragileSurchargePKR: num(input?.fragileSurchargePKR, 0, 100_000, 0),
    fuelSurchargePct: num(input?.fuelSurchargePct, 0, 100, 0),
    taxPct: num(input?.taxPct, 0, 100, 0),
    volumetricDivisor: num(input?.volumetricDivisor, 1000, 10_000, 5000),
  };
}

export function parseParcelType(v: unknown): ParcelType {
  return PARCEL_TYPES.includes(v as ParcelType) ? (v as ParcelType) : 'standard';
}

/** Cleans package dimensions (cm). Returns null when none were given; throws when partly given or out of range. */
export function cleanDimensions(raw: any): { l: number; w: number; h: number } | null {
  if (raw === undefined || raw === null) return null;
  const vals = [raw.l, raw.w, raw.h];
  if (vals.every((v) => v === undefined || v === null || v === '')) return null;
  const [l, w, h] = vals.map((v) => Number(v));
  if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Package length, width and height must all be numbers above 0');
  if ([l, w, h].some((n) => n > 200)) throw new Error('Package sides cannot be more than 200 cm');
  return { l, w, h };
}

/** Billable kg = the larger of real and volumetric weight (L x W x H / divisor). */
export function billableKg(weightKg: number, dims?: Dimensions | null, divisor = 5000): number {
  const real = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 0;
  const vol = dims && dims.l && dims.w && dims.h ? (dims.l * dims.w * dims.h) / divisor : 0;
  return Math.max(real, vol);
}

const norm = (s?: string | null) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Same city -> sameCity, same province -> sameProvince, anything else (or unknown origin) -> national. */
export function routeClass(
  origin: { city?: string | null; province?: string | null },
  dest: { city?: string | null; province?: string | null },
): RouteClass {
  const oc = norm(origin.city), dc = norm(dest.city);
  if (oc && dc && oc === dc) return 'sameCity';
  const op = norm(origin.province), dp = norm(dest.province);
  if (op && dp && op === dp) return 'sameProvince';
  return 'national';
}

export interface RateQuote { feePKR: number; route: RouteClass; billableKg: number }

/** Fee for ONE shipment (one store's parcel group). Heavier than the last slab = last slab + extra per started kg. */
export function quoteRate(
  table: RateTable,
  p: { route: RouteClass; billableKg: number; fragile?: boolean },
): RateQuote {
  const rr = table.routes[p.route];
  const kg = Math.max(p.billableKg, 0);
  const last = rr.slabs[rr.slabs.length - 1];
  let fee: number;
  const slab = rr.slabs.find((s) => kg <= s.upToKg + 1e-9);
  if (slab) fee = slab.feePKR;
  else fee = last.feePKR + Math.ceil(kg - last.upToKg - 1e-9) * rr.extraPerKgPKR;
  if (p.fragile) fee += table.fragileSurchargePKR;
  fee += fee * (table.fuelSurchargePct / 100);
  fee += fee * (table.taxPct / 100);
  return { feePKR: r2(fee), route: p.route, billableKg: r2(kg) };
}
