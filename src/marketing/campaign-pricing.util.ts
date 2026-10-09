/* eslint-disable prettier/prettier */

/** Shape shared by every consumer that needs to know "is this store on sale
 *  right now, and by how much" — checkout pricing, product/marketplace
 *  badges, and the store page banner all resolve to this same summary so
 *  there is exactly one definition of what an "active campaign" is. */
export interface ActiveCampaignForStore {
  campaignId:    string;
  name:          string;
  discountType:  'percentage' | 'fixed' | null;
  discountValue: number | null;
  /** Only meaningful when discountType === 'fixed' — see Campaign.currency. */
  currency:      string | null;
  endDate:       Date;
  /** Who bears the cost of this campaign's discount — see Campaign.sponsorType. */
  sponsorType:   'seller' | 'platform';
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/** Dollar amount a campaign would take off a given subtotal. A campaign with
 *  no discount configured (badge-only / merchandising campaign, see
 *  Campaign.discountType comment) always yields 0 — it's real, just not a
 *  price-changing one. */
export function computeCampaignDiscountAmount(campaign: ActiveCampaignForStore, subtotal: number): number {
  if (!campaign.discountType || campaign.discountValue == null || subtotal <= 0) return 0;
  const amount = campaign.discountType === 'percentage'
    ? subtotal * (campaign.discountValue / 100)
    : Math.min(campaign.discountValue, subtotal);
  return round(Math.max(0, amount));
}

/** A store can be opted into more than one overlapping campaign (two admin
 *  events whose date windows happen to intersect). Rather than stacking them
 *  (which would let two unrelated sales compound into a single item going to
 *  $0 or negative), exactly one applies — deterministically, the one that
 *  currently saves the buyer the most on this subtotal. Ties break on
 *  soonest-ending, so the more "urgent" sale wins the display too. */
export function pickBestCampaign(
  campaigns: ActiveCampaignForStore[],
  subtotal: number,
): { campaign: ActiveCampaignForStore; discountAmount: number } | null {
  if (campaigns.length === 0) return null;

  let best: { campaign: ActiveCampaignForStore; discountAmount: number } | null = null;
  for (const campaign of campaigns) {
    const discountAmount = computeCampaignDiscountAmount(campaign, subtotal);
    if (
      !best ||
      discountAmount > best.discountAmount ||
      (discountAmount === best.discountAmount && campaign.endDate < best.campaign.endDate)
    ) {
      best = { campaign, discountAmount };
    }
  }
  return best;
}

export interface CartCampaignDiscount {
  campaignId: string;
  name: string;
  /** the discount, in `currency` */
  amount: number;
  /** currency of `amount`: always the CART's own currency */
  currency: string;
  discountType: 'percentage' | 'fixed' | null;
  /** as configured: a percent, or - for a fixed sale - an amount in `valueCurrency` */
  discountValue: number | null;
  /** only for fixed sales: the currency `discountValue` is written in (a campaign is USD unless stated) */
  valueCurrency: string | null;
}

/**
 * The cart view of the running sale. A fixed-amount campaign value is in the campaign's currency (USD by default)
 * while the cart subtotal is in the store's currency, so the value is converted first and the returned `amount` is in
 * the CART's currency - a PKR cart never reports "USD". A fixed campaign that cannot be converted (no rate / no
 * converter) is left out of the cart view rather than shown with a wrong number.
 */
export async function resolveCartCampaignDiscount(
  rawCampaigns: any[],
  subtotal: number,
  cartCurrency: string,
  convert?: (amount: number, from: string, to: string) => Promise<number>,
): Promise<CartCampaignDiscount | null> {
  const candidates: Array<ActiveCampaignForStore & { origValue: number | null; valueCurrency: string | null }> = [];
  for (const c of rawCampaigns) {
    let value: number | null = c.discountValue ?? null;
    const valueCurrency: string | null = c.discountType === 'fixed' ? (c.currency ?? 'USD') : null;
    if (c.discountType === 'fixed' && value != null && valueCurrency && valueCurrency !== cartCurrency) {
      if (!convert) continue;
      try { value = await convert(value, valueCurrency, cartCurrency); } catch { continue; }
    }
    candidates.push({
      campaignId: String(c._id), name: c.name, discountType: c.discountType ?? null, discountValue: value,
      currency: cartCurrency, endDate: c.endDate, sponsorType: c.sponsorType ?? 'seller',
      origValue: c.discountValue ?? null, valueCurrency,
    });
  }
  const best = pickBestCampaign(candidates, subtotal);
  const chosen = best ? candidates.find((c) => c.campaignId === best.campaign.campaignId) : null;
  if (!best || !chosen || best.discountAmount <= 0) return null;
  return {
    campaignId: chosen.campaignId, name: chosen.name, amount: best.discountAmount, currency: cartCurrency,
    discountType: chosen.discountType, discountValue: chosen.origValue, valueCurrency: chosen.valueCurrency,
  };
}

/** Badge/merchandising selection (no dollar amount in play — e.g. a product
 *  card just needs "which sale is this in"). Prefers a campaign that actually
 *  carries a discount over a badge-only one, then soonest-ending. */
export function pickPrimaryCampaignForBadge(campaigns: ActiveCampaignForStore[]): ActiveCampaignForStore | null {
  if (campaigns.length === 0) return null;
  return [...campaigns].sort((a, b) => {
    const aHasDiscount = a.discountType != null && a.discountValue != null;
    const bHasDiscount = b.discountType != null && b.discountValue != null;
    if (aHasDiscount !== bHasDiscount) return aHasDiscount ? -1 : 1;
    return a.endDate.getTime() - b.endDate.getTime();
  })[0];
}
