/* eslint-disable prettier/prettier */
import { ActiveCampaignForStore } from './campaign-pricing.util';

/**
 * STRICT PER-PRODUCT CAMPAIGN PARTICIPATION - the one rule used by checkout, cart, product badges and store pages.
 *
 * A product is IN campaign C only when
 *   (1) the store is eligible for C   (sponsorType 'platform', or the store is in C.participatingStoreIds)
 *       - callers get that from MarketingService.getActiveCampaignsForStores, which only lists such campaigns; AND
 *   (2) C is in product.campaignIds (the seller ticked it for this product).
 *
 * There is NO whole-store fallback: a store that joined a campaign but never ticked a product has no discounted
 * products (the old "no product ticked => whole store" rule was removed on purpose).
 */

/** Pure rule (2) - rule (1) is already applied by the caller's campaign list. */
export function isProductInCampaign(campaignId: string, productCampaignIds: readonly string[] | null | undefined): boolean {
  return !!productCampaignIds && productCampaignIds.includes(campaignId);
}

/** Campaigns (from the store-eligible list) a given product is in. */
export function campaignsForProduct(
  storeCampaigns: ActiveCampaignForStore[] | undefined,
  productCampaignIds: readonly string[] | null | undefined,
): ActiveCampaignForStore[] {
  if (!storeCampaigns?.length || !productCampaignIds?.length) return [];
  return storeCampaigns.filter((c) => isProductInCampaign(c.campaignId, productCampaignIds));
}

/** Batched lookup for a page / cart: each product's own campaign list (one query; none when there is nothing to look up). */
export async function loadCampaignContext(
  productModel: any,
  productIds: string[],
): Promise<{ campaignIdsByProduct: Map<string, string[]> }> {
  const campaignIdsByProduct = new Map<string, string[]>();
  if (productIds.length === 0) return { campaignIdsByProduct };
  const products = await productModel.find({ _id: { $in: productIds } }).select('campaignIds').lean();
  for (const p of products as any[]) campaignIdsByProduct.set(String(p._id), p.campaignIds ?? []);
  return { campaignIdsByProduct };
}

/** Accepts only a list of ids (max 10). Anything else -> null (caller answers 400). Duplicates removed. */
export function parseCampaignIdsInput(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 10) return null;
  if (!raw.every((x) => typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x))) return null;
  return [...new Set(raw as string[])];
}
