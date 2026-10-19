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

/** The percent the seller gives premium members on a product: product override first, else the store setting. 0 = none.
 *  `premiumOptOut` (the seller turned Premium off for this product, e.g. to join a platform sale) = always 0. */
export function premiumPercentFor(product: { premiumDiscountPercent?: number | null; premiumOptOut?: boolean | null } | null | undefined, store: { premiumDiscount?: { enabled?: boolean; percent?: number } | null } | null | undefined): number {
  if (product?.premiumOptOut === true) return 0;
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

// ── Premium terms (admin settings) and the price rules R1-R4 ────────────────────────────────────────────────────────

export const PREMIUM_PLATFORM_MAX_PERCENT = 30;
export const PREMIUM_FEE_MAX_PERCENT = 30;
export const PREMIUM_GAP_MAX_PERCENT = 50;

/** What the admin controls on the Premium page. */
export interface PremiumSettingsShape {
  platformDiscount: { enabled: boolean; percent: number };
  premiumSellerFeePercent: number;
  minGapPercent: number;
}
export const DEFAULT_PREMIUM_SETTINGS: PremiumSettingsShape = {
  platformDiscount: { enabled: true, percent: 5 },
  premiumSellerFeePercent: 5,
  minGapPercent: 5,
};

/** The effective numbers pricing / fee / validation code uses (platformPercent is already 0 when the offer is off). */
export interface PremiumTerms {
  platformEnabled: boolean;
  platformPercent: number;
  sellerFeePercent: number;
  minGapPercent: number;
}
export function termsFromSettings(s?: Partial<PremiumSettingsShape> | null): PremiumTerms {
  const d = DEFAULT_PREMIUM_SETTINGS;
  const enabled = s?.platformDiscount?.enabled ?? d.platformDiscount.enabled;
  const pct = Number(s?.platformDiscount?.percent ?? d.platformDiscount.percent);
  const fee = Number(s?.premiumSellerFeePercent ?? d.premiumSellerFeePercent);
  const gap = Number(s?.minGapPercent ?? d.minGapPercent);
  const clamp = (n: number, max: number, fb: number) => (Number.isFinite(n) && n >= 0 && n <= max ? n : fb);
  const platformPercent = clamp(pct, PREMIUM_PLATFORM_MAX_PERCENT, d.platformDiscount.percent);
  return {
    platformEnabled: !!enabled && platformPercent > 0,
    platformPercent: enabled ? platformPercent : 0,
    sellerFeePercent: clamp(fee, PREMIUM_FEE_MAX_PERCENT, d.premiumSellerFeePercent),
    minGapPercent: clamp(gap, PREMIUM_GAP_MAX_PERCENT, d.minGapPercent),
  };
}
export const DEFAULT_PREMIUM_TERMS: PremiumTerms = termsFromSettings(DEFAULT_PREMIUM_SETTINGS);

/** Validates an admin PUT body. Every field optional; returns the merged, validated settings. */
export function cleanPremiumSettings(body: any, current: PremiumSettingsShape): PremiumSettingsShape {
  const out: PremiumSettingsShape = { platformDiscount: { ...current.platformDiscount }, premiumSellerFeePercent: current.premiumSellerFeePercent, minGapPercent: current.minGapPercent };
  const num = (v: unknown, name: string, max: number) => {
    const n = Number(v);
    if (v === null || v === '' || !Number.isFinite(n) || n < 0 || n > max) throw new BadRequestException(`${name} must be a number between 0 and ${max}`);
    return Math.round(n * 100) / 100;
  };
  if (body?.platformDiscount !== undefined) {
    const p = body.platformDiscount;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new BadRequestException('platformDiscount must be an object { enabled, percent }');
    if (p.enabled !== undefined) out.platformDiscount.enabled = !!p.enabled;
    if (p.percent !== undefined) out.platformDiscount.percent = num(p.percent, 'platformDiscount.percent', PREMIUM_PLATFORM_MAX_PERCENT);
  }
  if (body?.premiumSellerFeePercent !== undefined) out.premiumSellerFeePercent = num(body.premiumSellerFeePercent, 'premiumSellerFeePercent', PREMIUM_FEE_MAX_PERCENT);
  if (body?.minGapPercent !== undefined) out.minGapPercent = num(body.minGapPercent, 'minGapPercent', PREMIUM_GAP_MAX_PERCENT);
  return out;
}

/** LIST price = the original price: compare-at when it is above the selling price (that is the seller's normal sale), else the price. */
export function listUnitPrice(price: number, compareAtPrice?: number | null): number {
  return typeof compareAtPrice === 'number' && compareAtPrice > price ? compareAtPrice : price;
}

/** The seller's NORMAL sale as a percent of the list price (compare-at vs price). 0 = no sale. */
export function normalSalePercent(price: number, compareAtPrice?: number | null): number {
  return typeof compareAtPrice === 'number' && compareAtPrice > price && compareAtPrice > 0 ? (1 - price / compareAtPrice) * 100 : 0;
}

export interface PremiumLinePrice {
  /** false = the member gets nothing better than the normal price here (no premium on this line). */
  applies: boolean;
  listUnit: number;
  /** What the member pays per unit. */
  unit: number;
  sellerPercent: number;
  platformPercent: number;
  /** sellerPercent + platformPercent (additive, never compounded). */
  totalPercent: number;
  /** Per unit: the seller-funded part (list x seller%) and the platform-funded part (list x platform%). unit + platform = what the seller is credited. */
  sellerUnitDiscount: number;
  platformUnitDiscount: number;
}

/**
 * R2: premium price = LIST x (1 - seller% - platform%). `price` is the normal (non-member) selling price, used for the
 * safety net: a member is never charged more than a normal buyer, so when the premium price is not strictly lower
 * than `price` it does not apply and the line stays at the normal price.
 */
export function premiumLinePrice(price: number, compareAtPrice: number | null | undefined, sellerPercent: number, platformPercent: number): PremiumLinePrice {
  const listUnit = listUnitPrice(price, compareAtPrice);
  const none: PremiumLinePrice = { applies: false, listUnit, unit: price, sellerPercent: 0, platformPercent: 0, totalPercent: 0, sellerUnitDiscount: 0, platformUnitDiscount: 0 };
  if (!(sellerPercent > 0)) return none;
  const p = platformPercent > 0 ? platformPercent : 0;
  const total = sellerPercent + p;
  const unit = round2(Math.max(0, listUnit * (1 - total / 100)));
  if (!(unit < price)) return none;
  const platformUnitDiscount = Math.min(round2(listUnit * p / 100), round2(listUnit - unit));
  const sellerUnitDiscount = round2(listUnit - unit - platformUnitDiscount);
  return { applies: true, listUnit, unit, sellerPercent, platformPercent: p, totalPercent: round2(total), sellerUnitDiscount, platformUnitDiscount };
}

/**
 * The 'Premium members save up to X%' teaser, measured against what the buyer would pay NOW (normalUnit: the price after
 * any running sale / subscriber price), not against the list price - so a product already 16% off whose member price is 33%
 * below list advertises the extra 17%, never a figure that double-counts the sale. null = Premium would not beat the price
 * a normal buyer pays, so no teaser. Seller / Edudeen parts are scaled to the advertised percent.
 */
export function premiumTeaser(price: number, compareAtPrice: number | null | undefined, normalUnit: number | null | undefined, sellerPercent: number, platformPercent: number): { premiumPercent: number; premiumSellerPercent: number; premiumPlatformPercent: number } | null {
  const calc = premiumLinePrice(price, compareAtPrice, sellerPercent, platformPercent);
  const vs = Math.min(typeof normalUnit === 'number' ? normalUnit : price, price);
  if (!calc.applies || !(vs > 0) || !(calc.unit < vs)) return null;
  const pct = round2((1 - calc.unit / vs) * 100);
  const seller = round2(pct * (calc.totalPercent > 0 ? calc.sellerPercent / calc.totalPercent : 1));
  return { premiumPercent: pct, premiumSellerPercent: seller, premiumPlatformPercent: round2(pct - seller) };
}

/**
 * Applies the premium price to one checkout line IN PLACE (R1: the member gets ONLY the premium price - the compare-at
 * sale, store-subscriber price and automatic discounts are not applied on top; the caller keeps campaign/automatic
 * discounts away from lines this marks). `price` of the line must still be the normal selling price when called.
 * Returns what was given, or applied=false when the member price would not beat the normal price.
 */
export function applyPremiumToLine(
  item: any, variant: { price: number; compareAtPrice?: number | null }, sellerPercent: number, terms: PremiumTerms,
): { applied: boolean; sellerDiscount: number; platformDiscount: number; replacedSubscriberDiscount: number; replacedCampaignDiscount: number; replacedCampaignId: string | null; replacedAutoDiscount: number } {
  const calc = premiumLinePrice(variant.price, variant.compareAtPrice, sellerPercent, terms.platformPercent);
  const none = { applied: false, sellerDiscount: 0, platformDiscount: 0, replacedSubscriberDiscount: 0, replacedCampaignDiscount: 0, replacedCampaignId: null, replacedAutoDiscount: 0 };
  // Premium competes with the FULL normal pipeline: the line's current unit price (after subscriber / campaign / automatic
  // discounts, i.e. exactly what a normal buyer pays). If that is lower or equal the line stays a normal line.
  const normalUnit = item.quantity > 0 ? round2(item.totalPrice / item.quantity) : item.price;
  if (!calc.applies || !(calc.unit < normalUnit)) return none;
  const replaced = item.subscriberDiscountUSD ?? 0;
  const replacedCampaign = item.campaignDiscountUSD ?? 0;
  const replacedCampaignId = item.campaignId ?? null;
  const replacedAuto = item.autoDiscountUSD ?? 0;
  item.campaignId = null; item.campaignDiscountUSD = 0; item.campaignSponsorType = null;
  item.autoDiscountId = null; item.autoDiscountUSD = 0;
  const sellerDiscount = round2(calc.sellerUnitDiscount * item.quantity);
  const platformDiscount = round2(calc.platformUnitDiscount * item.quantity);
  item.originalPrice = calc.listUnit;
  item.price = calc.unit;
  item.totalPrice = round2(calc.unit * item.quantity);
  item.subscriberDiscountUSD = 0;
  item.premiumDiscountUSD = sellerDiscount;
  item.premiumPlatformDiscountUSD = platformDiscount;
  item.premiumDiscountPercent = calc.totalPercent;
  item.premiumSellerPercent = calc.sellerPercent;
  item.premiumPlatformPercent = calc.platformPercent;
  item.premiumFeePercent = terms.sellerFeePercent;
  return { applied: true, sellerDiscount, platformDiscount, replacedSubscriberDiscount: replaced, replacedCampaignDiscount: replacedCampaign, replacedCampaignId, replacedAutoDiscount: replacedAuto };
}

const fmtPct = (n: number) => String(Math.round(n * 10) / 10);

/**
 * R3: the seller's normal sale must stay at least `minGapPercent` points below the Premium discount. Returns the error
 * message when violated (null = fine). `sellerPercent` 0 = no Premium on the product, nothing to check.
 */
export function premiumGapViolation(sellerPercent: number, prices: Array<{ price: number; compareAtPrice?: number | null }>, minGapPercent: number): string | null {
  if (!(sellerPercent > 0)) return null;
  const maxSale = Math.max(0, sellerPercent - minGapPercent);
  let worst = 0;
  for (const p of prices) {
    const s = normalSalePercent(Number(p.price), p.compareAtPrice ?? null);
    if (s > worst) worst = s;
  }
  if (!(worst > 0) || worst <= maxSale + 1e-9) return null;
  const raiseTo = Math.ceil((worst + minGapPercent) * 10) / 10;
  return `Your normal sale is ${fmtPct(worst)}% but your Premium discount is ${fmtPct(sellerPercent)}%. Premium must be at least ${fmtPct(minGapPercent)} points better - lower the sale to ${fmtPct(maxSale)}% or raise Premium to ${fmtPct(raiseTo)}%.`;
}
