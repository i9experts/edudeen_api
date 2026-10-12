/* eslint-disable prettier/prettier */
import { ActiveCampaignForStore, computeCampaignDiscountAmount } from './campaign-pricing.util';

/**
 * PER-PRODUCT CAMPAIGN PARTICIPATION - the one rule used by checkout, cart, product badges and store pages.
 *
 * A product is IN campaign C when
 *   (1) the store is eligible for C   (sponsorType 'platform', or the store is in C.participatingStoreIds)
 *       - callers get that from MarketingService.getActiveCampaignsForStores, which only lists such campaigns; AND
 *   (2) C is in product.campaignIds (the seller ticked it for this product)
 *       OR the store has NO product at all (not deleted) with C selected   [legacy: whole-store participation for
 *       stores that never made a per-product choice].
 *
 * "Selection" = Set of `${storeId}:${campaignId}` for every pair where at least one product of the store ticked C.
 */
export type CampaignSelection = Set<string>;

export const selectionKey = (storeId: string, campaignId: string) => `${storeId}:${campaignId}`;

/** Pure rule (2) - rule (1) is already applied by the caller's campaign list. */
export function isProductInCampaign(
  campaignId: string,
  storeId: string,
  productCampaignIds: readonly string[] | null | undefined,
  selection: CampaignSelection,
): boolean {
  if (productCampaignIds && productCampaignIds.includes(campaignId)) return true;
  return !selection.has(selectionKey(storeId, campaignId));
}

/** Campaigns (from the store-eligible list) a given product is in. */
export function campaignsForProduct(
  storeCampaigns: ActiveCampaignForStore[] | undefined,
  storeId: string,
  productCampaignIds: readonly string[] | null | undefined,
  selection: CampaignSelection,
): ActiveCampaignForStore[] {
  if (!storeCampaigns?.length) return [];
  return storeCampaigns.filter((c) => isProductInCampaign(c.campaignId, storeId, productCampaignIds, selection));
}

export interface PricedItem { productId: string; amount: number }

/**
 * Best single campaign for a store's cart lines, each campaign valued on ITS OWN eligible lines only
 * (a percentage applies to the eligible subtotal, a fixed amount is capped by it). Ties break on soonest-ending,
 * same as pickBestCampaign. Returns the winning campaign, its discount and the productIds it applies to.
 */
export function pickBestCampaignForItems(
  campaigns: ActiveCampaignForStore[],
  storeId: string,
  items: PricedItem[],
  campaignIdsByProduct: Map<string, string[]>,
  selection: CampaignSelection,
): { campaign: ActiveCampaignForStore; discountAmount: number; productIds: string[] } | null {
  let best: { campaign: ActiveCampaignForStore; discountAmount: number; productIds: string[] } | null = null;
  for (const campaign of campaigns) {
    const eligible = items.filter((i) => isProductInCampaign(campaign.campaignId, storeId, campaignIdsByProduct.get(i.productId), selection));
    if (eligible.length === 0) continue;
    const subtotal = Math.round(eligible.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    const discountAmount = computeCampaignDiscountAmount(campaign, subtotal);
    if (!best || discountAmount > best.discountAmount || (discountAmount === best.discountAmount && campaign.endDate < best.campaign.endDate)) {
      best = { campaign, discountAmount, productIds: [...new Set(eligible.map((i) => i.productId))] };
    }
  }
  return best;
}

/** Batched lookups for a page / cart: which (store,campaign) pairs have a per-product choice, and each product's own list.
 *  Two queries total regardless of size. Skipped entirely when there is no campaign to evaluate. */
export async function loadCampaignContext(
  productModel: any,
  storeIds: string[],
  campaignIds: string[],
  productIds: string[],
): Promise<{ selection: CampaignSelection; campaignIdsByProduct: Map<string, string[]> }> {
  const selection: CampaignSelection = new Set();
  const campaignIdsByProduct = new Map<string, string[]>();
  if (storeIds.length === 0 || campaignIds.length === 0) return { selection, campaignIdsByProduct };

  const [pairs, products] = await Promise.all([
    productModel.aggregate([
      { $match: { storeId: { $in: storeIds }, isDelete: false, campaignIds: { $in: campaignIds } } },
      { $unwind: '$campaignIds' },
      { $match: { campaignIds: { $in: campaignIds } } },
      { $group: { _id: { s: '$storeId', c: '$campaignIds' } } },
    ]),
    productIds.length ? productModel.find({ _id: { $in: productIds } }).select('campaignIds').lean() : Promise.resolve([]),
  ]);
  for (const p of pairs as any[]) selection.add(selectionKey(p._id.s, p._id.c));
  for (const p of products as any[]) campaignIdsByProduct.set(String(p._id), p.campaignIds ?? []);
  return { selection, campaignIdsByProduct };
}

/** Accepts only a list of ids (max 10). Anything else -> null (caller answers 400). Duplicates removed. */
export function parseCampaignIdsInput(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 10) return null;
  if (!raw.every((x) => typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x))) return null;
  return [...new Set(raw as string[])];
}
