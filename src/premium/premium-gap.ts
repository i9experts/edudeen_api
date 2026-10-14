/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { PremiumEntitlementsService } from './premium-entitlements.service';
import { premiumGapViolation, premiumPercentFor } from './premium.util';

/**
 * R3 (enforced on product create / edit and variant create / edit): when a Premium percent applies to the product
 * (product override, else the store setting) AND one of `prices` carries a normal sale (compare-at above price), the sale
 * must be at least the admin's minimum gap below the Premium percent. Throws 400 with the seller-facing message.
 * No-op without the premium module, without a Premium percent, or without a sale. Never used for store-level changes.
 */
export async function assertPremiumGap(
  premium: Pick<PremiumEntitlementsService, 'getTerms'> | undefined | null,
  store: { premiumDiscount?: { enabled?: boolean; percent?: number } | null } | null | undefined,
  productPercent: number | null | undefined,
  prices: Array<{ price: number; compareAtPrice?: number | null }>,
  premiumOptOut = false,
): Promise<void> {
  if (!premium || typeof premium.getTerms !== 'function' || !prices.length) return;
  if (!prices.some((p) => typeof p.compareAtPrice === 'number' && p.compareAtPrice > p.price)) return;
  const sellerPct = premiumPercentFor({ premiumDiscountPercent: productPercent ?? null, premiumOptOut }, store);
  if (!sellerPct) return;
  const { minGapPercent } = await premium.getTerms();
  const message = premiumGapViolation(sellerPct, prices, minGapPercent);
  if (message) throw new BadRequestException(message);
}
