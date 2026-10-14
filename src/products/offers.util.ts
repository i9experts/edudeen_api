/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { cleanPremiumPercent, premiumPercentFor } from '../premium/premium.util';

/** A product is either in a platform sale OR has a Premium member offer - never both (owner rule R3). */
export const OFFER_CONFLICT_MESSAGE = 'A product can be in a platform sale or have a Premium offer, not both - turn one off';

/** undefined = untouched; true/false = the seller's choice; anything else -> 400. */
export function cleanPremiumOptOut(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new BadRequestException('premiumOptOut must be true or false');
  return v;
}

/**
 * The Premium fields a create / edit body carries. Setting a percent without saying anything about premiumOptOut turns the
 * opt-out OFF (the seller wants Premium on for this product).
 */
export function premiumFieldsFromBody(body: any): { premiumDiscountPercent?: number | null; premiumOptOut?: boolean } {
  const pct = cleanPremiumPercent(body?.premiumDiscountPercent);
  const optOut = cleanPremiumOptOut(body?.premiumOptOut);
  const out: { premiumDiscountPercent?: number | null; premiumOptOut?: boolean } = {};
  if (pct !== undefined) out.premiumDiscountPercent = pct;
  if (optOut !== undefined) out.premiumOptOut = optOut;
  else if (typeof pct === 'number') out.premiumOptOut = false;
  return out;
}

/** The effective Premium percent (0 = none) of a product's NEXT state. */
export function effectivePremiumPercent(
  store: { premiumDiscount?: { enabled?: boolean; percent?: number } | null } | null | undefined,
  next: { premiumDiscountPercent?: number | null; premiumOptOut?: boolean | null },
): number {
  return premiumPercentFor({ premiumDiscountPercent: next.premiumDiscountPercent ?? null, premiumOptOut: next.premiumOptOut === true }, store);
}

/** 400 when the product's next state has BOTH an effective Premium offer and a platform campaign. */
export function assertOfferExclusive(
  store: { premiumDiscount?: { enabled?: boolean; percent?: number } | null } | null | undefined,
  next: { premiumDiscountPercent?: number | null; premiumOptOut?: boolean | null; campaignIds?: readonly string[] | null },
): void {
  if ((next.campaignIds?.length ?? 0) > 0 && effectivePremiumPercent(store, next) > 0) throw new BadRequestException(OFFER_CONFLICT_MESSAGE);
}
