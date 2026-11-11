/* Pure rules for seller coupon scope / start date / per-customer limits.
 * Old docs have none of the new fields: they read as store-wide, started, unlimited per buyer, private. */

export type CouponRuleFields = {
  appliesTo?: 'store' | 'categories' | 'products' | null;
  targetIds?: string[] | null;
  startsAt?: Date | string | null;
  expiresAt?: Date | string | null;
  perCustomerLimit?: number | null;
  firstOrderOnly?: boolean | null;
  visibility?: 'public' | 'private' | null;
  isActive?: boolean;
  usageLimit?: number | null;
  usageCount?: number;
};

export function couponScope(c: CouponRuleFields): 'store' | 'categories' | 'products' {
  return c.appliesTo === 'categories' || c.appliesTo === 'products' ? c.appliesTo : 'store';
}

export function hasStarted(c: CouponRuleFields, now = new Date()): boolean {
  return !c.startsAt || new Date(c.startsAt).getTime() <= now.getTime();
}

export function isExpired(c: CouponRuleFields, now = new Date()): boolean {
  return !!c.expiresAt && new Date(c.expiresAt).getTime() < now.getTime();
}

/** Public badge only: public + active + started + not expired + not used up. */
export function isBadgeLive(c: CouponRuleFields, now = new Date()): boolean {
  if (c.visibility !== 'public' || c.isActive === false) return false;
  if (!hasStarted(c, now) || isExpired(c, now)) return false;
  if (c.usageLimit != null && (c.usageCount ?? 0) >= c.usageLimit) return false;
  return true;
}

export type CouponLine = { productId: string; categoryIds: string[] };

/** `expandedTargets` = targetIds, plus all category descendants when appliesTo is 'categories'. */
export function lineMatchesCoupon(c: CouponRuleFields, line: CouponLine, expandedTargets: Set<string>): boolean {
  const scope = couponScope(c);
  if (scope === 'store') return true;
  if (scope === 'products') return expandedTargets.has(String(line.productId));
  return line.categoryIds.some((id) => id && expandedTargets.has(String(id)));
}

/** Validation of the merged coupon values. Returns an error message or null. */
export function couponValueError(type: string, value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return 'Discount value must be greater than 0';
  if (type === 'percentage' && value > 90) return 'Percentage discount cannot exceed 90';
  return null;
}

export function couponDateError(startsAt: Date | null | undefined, expiresAt: Date | null | undefined): string | null {
  if (startsAt && Number.isNaN(startsAt.getTime())) return 'Invalid start date';
  if (startsAt && expiresAt && startsAt.getTime() >= expiresAt.getTime()) return 'Start date must be before the expiry date';
  return null;
}
