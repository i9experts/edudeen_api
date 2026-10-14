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
  /** true when the campaign has not started yet and is only visible/buyable because the buyer is Premium (early access). */
  earlyAccess?:  boolean;
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
  subtotal: number | ((campaignId: string) => number),
): { campaign: ActiveCampaignForStore; discountAmount: number } | null {
  if (campaigns.length === 0) return null;

  let best: { campaign: ActiveCampaignForStore; discountAmount: number } | null = null;
  for (const campaign of campaigns) {
    // a function lets each campaign be valued on its own set of eligible items (per-product participation)
    const discountAmount = computeCampaignDiscountAmount(campaign, typeof subtotal === 'function' ? subtotal(campaign.campaignId) : subtotal);
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

// ── Per-line campaign price (owner rule R1) ─────────────────────────────────────────────────────────────────────────
//
// An offer from Edudeen is computed from the LIST price (compare-at when it is above the selling price, else the price):
//     percentage:  unit = list - list x pct/100          fixed:  unit = list - amount
// The buyer pays min(normal price, campaign unit): the campaign only applies when it is STRICTLY cheaper than what the
// buyer would already pay (a tie stays normal). `discount` is measured against that normal price, so for a
// platform-sponsored campaign it is exactly what the platform reimburses (seller is credited their own price), and for a
// seller-sponsored one it is what the seller gives up (seller receives what the buyer pays).

export interface CampaignLinePrice {
  campaign: ActiveCampaignForStore;
  /** the base the offer was computed from */
  listUnit: number;
  /** what the buyer pays per unit under the campaign */
  unit: number;
  /** normal price - unit (> 0) */
  discount: number;
}

/** The list price: compare-at when it is above the selling price, else the price (same base as Edudeen Premium). */
export function campaignListUnit(price: number, compareAtPrice?: number | null): number {
  return typeof compareAtPrice === 'number' && compareAtPrice > price ? compareAtPrice : price;
}

/** One campaign on one line. `normalUnit` = what the buyer pays without the campaign (default: `price`). null = does not apply. */
export function campaignLinePrice(
  campaign: ActiveCampaignForStore, price: number, compareAtPrice?: number | null, normalUnit: number = price,
): CampaignLinePrice | null {
  if (!campaign.discountType || campaign.discountValue == null || !(price > 0)) return null;
  const listUnit = campaignListUnit(price, compareAtPrice);
  const off = campaign.discountType === 'percentage'
    ? round(listUnit * (Math.min(campaign.discountValue, 100) / 100))
    : Math.min(campaign.discountValue, listUnit);
  const unit = round(Math.max(0, listUnit - off));
  if (!(unit < normalUnit)) return null;
  return { campaign, listUnit, unit, discount: round(normalUnit - unit) };
}

/** Best campaign for a line: the lowest resulting unit price; ties break on soonest-ending. null when none applies. */
export function pickBestCampaignForLine(
  campaigns: ActiveCampaignForStore[], price: number, compareAtPrice?: number | null, normalUnit: number = price,
): CampaignLinePrice | null {
  let best: CampaignLinePrice | null = null;
  for (const c of campaigns) {
    const r = campaignLinePrice(c, price, compareAtPrice, normalUnit);
    if (!r) continue;
    if (!best || r.unit < best.unit || (r.unit === best.unit && c.endDate < best.campaign.endDate)) best = r;
  }
  return best;
}

/**
 * Display: stamps each variant the campaign really discounts with `campaignPrice` / `campaignId` / `campaignListPrice`
 * (and hides the seller's own markdown on it - `originalCompareAtPrice` keeps it). `campaigns` = the campaigns this
 * product is IN. `primary` = the campaign behind the cheapest variant (null when none applies).
 */
export function applyCampaignsToVariants(campaigns: ActiveCampaignForStore[], variants: any[]): { variants: any[]; primary: ActiveCampaignForStore | null; appliedPrice: number | null } {
  const withDiscount = campaigns.filter((c) => c.discountType != null && c.discountValue != null);
  let cheapest: { unit: number; campaign: ActiveCampaignForStore } | null = null;
  const out = variants.map((v: any) => {
    const r = withDiscount.length && typeof v.price === 'number' ? pickBestCampaignForLine(withDiscount, v.price, v.compareAtPrice ?? null) : null;
    if (!r) return v;
    if (!cheapest || r.unit < cheapest.unit) cheapest = { unit: r.unit, campaign: r.campaign };
    return { ...v, campaignPrice: r.unit, campaignId: r.campaign.campaignId, campaignListPrice: r.listUnit, originalCompareAtPrice: v.compareAtPrice ?? null, compareAtPrice: null };
  });
  const c = cheapest as { unit: number; campaign: ActiveCampaignForStore } | null;
  return { variants: out, primary: c ? c.campaign : null, appliedPrice: c ? c.unit : null };
}

/** Cart/checkout: raw campaign docs -> campaigns whose fixed value is expressed in `targetCurrency` (a fixed one that cannot be converted is left out). */
export async function campaignsInCurrency(
  rawCampaigns: any[],
  targetCurrency: string,
  convert?: (amount: number, from: string, to: string) => Promise<number>,
): Promise<Array<ActiveCampaignForStore & { origValue: number | null; valueCurrency: string | null }>> {
  const out: Array<ActiveCampaignForStore & { origValue: number | null; valueCurrency: string | null }> = [];
  for (const c of rawCampaigns) {
    let value: number | null = c.discountValue ?? null;
    const valueCurrency: string | null = c.discountType === 'fixed' ? (c.currency ?? 'USD') : null;
    if (c.discountType === 'fixed' && value != null && valueCurrency && valueCurrency !== targetCurrency) {
      if (!convert) continue;
      try { value = await convert(value, valueCurrency, targetCurrency); } catch { continue; }
    }
    out.push({
      campaignId: String(c._id ?? c.campaignId), name: c.name, discountType: c.discountType ?? null, discountValue: value,
      currency: targetCurrency, endDate: c.endDate, sponsorType: c.sponsorType ?? 'seller',
      origValue: c.discountValue ?? null, valueCurrency,
    });
  }
  return out;
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
  /** per-product participation: the subtotal of the lines that are IN a given campaign (default: the whole subtotal) */
  subtotalFor?: (campaignId: string) => number,
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
  const best = pickBestCampaign(candidates, subtotalFor ?? subtotal);
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
