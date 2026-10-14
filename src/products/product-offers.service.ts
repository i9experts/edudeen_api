/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { MarketingService } from '../marketing/marketing.service';
import { PremiumEntitlementsService } from '../premium/premium-entitlements.service';
import { cleanPremiumPercent, premiumGapViolation, DEFAULT_PREMIUM_TERMS } from '../premium/premium.util';

export const MAX_BULK_OFFER_PRODUCTS = 200;
export const MAX_CAMPAIGNS_PER_PRODUCT = 10;
export const BULK_OFFER_ACTIONS = ['premium_on', 'premium_off', 'campaign_add', 'campaign_remove'] as const;
export type BulkOfferAction = (typeof BULK_OFFER_ACTIONS)[number];

export interface BulkOffersInput { storeId: string; productIds: string[]; action: BulkOfferAction; percent?: number; campaignId?: string }

/** Validates the payload shape (pure). Throws 400. */
export function normaliseBulkOffers(body: any): BulkOffersInput {
  const storeId = typeof body?.storeId === 'string' ? body.storeId : '';
  if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid storeId');
  const raw = body?.productIds;
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('productIds must be a non-empty array');
  if (raw.length > MAX_BULK_OFFER_PRODUCTS) throw new BadRequestException(`At most ${MAX_BULK_OFFER_PRODUCTS} products per request`);
  if (!raw.every((x) => typeof x === 'string' && isValidObjectId(x))) throw new BadRequestException('productIds must be valid product ids');
  const action = body?.action as BulkOfferAction;
  if (!BULK_OFFER_ACTIONS.includes(action)) throw new BadRequestException(`action must be one of: ${BULK_OFFER_ACTIONS.join(', ')}`);
  const out: BulkOffersInput = { storeId, productIds: [...new Set(raw as string[])], action };
  if (action === 'premium_on') {
    const pct = cleanPremiumPercent(body?.percent);
    if (typeof pct !== 'number') throw new BadRequestException('percent is required (1-50) to add products to the Premium offer');
    out.percent = pct;
  }
  if (action === 'campaign_add' || action === 'campaign_remove') {
    const id = typeof body?.campaignId === 'string' ? body.campaignId : '';
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('campaignId is required');
    out.campaignId = id;
  }
  return out;
}

/**
 * Seller bulk tool: Premium offer / platform-sale membership for many products of ONE store the caller owns
 * (owner rules R3/R5). A product is in a platform sale OR has a Premium offer, never both, so
 *   premium_on      -> premiumDiscountPercent = percent, premiumOptOut = false, leaves every platform sale
 *   premium_off     -> premiumDiscountPercent = null,   premiumOptOut = true   (also beats a store-wide default)
 *   campaign_add    -> campaignId added,                premiumOptOut = true, own Premium percent cleared
 *   campaign_remove -> campaignId removed
 * A product that cannot take the change (not found, Premium gap rule, 10-campaign cap) is SKIPPED with a reason; the rest
 * of the batch still applies.
 */
@Injectable()
export class ProductOffersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly marketingService: MarketingService,
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  async bulkOffers(sellerId: string, body: any) {
    const input = normaliseBulkOffers(body);
    const { storeModel, productModel, productVariantModel } = this.databaseService.repositories;
    await verifyStoreOwnershipOrForbidden(storeModel, input.storeId, sellerId);

    const products: any[] = await productModel
      .find({ _id: { $in: input.productIds }, storeId: input.storeId, sellerId, isDelete: false })
      .select('name campaignIds premiumDiscountPercent premiumOptOut')
      .lean();
    const byId = new Map<string, any>(products.map((p) => [String(p._id), p]));

    const updated: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const ops: any[] = [];

    // campaign_add: the campaign must be active/upcoming and open to this store (a seller-sponsored one is joined by ticking it).
    let campaignId: string | null = null;
    if (input.action === 'campaign_add') {
      const ok = await this.marketingService.resolveProductCampaignIds(input.storeId, [input.campaignId]);
      if (!ok.length) throw new BadRequestException('That campaign is not available (it must be active or upcoming)');
      campaignId = ok[0];
    }

    // premium_on: the seller's normal sale must stay the admin's minimum gap below the Premium percent (per product).
    let variantsByProduct = new Map<string, any[]>();
    let minGap = DEFAULT_PREMIUM_TERMS.minGapPercent;
    if (input.action === 'premium_on' && products.length) {
      const variants: any[] = await productVariantModel
        .find({ productId: { $in: products.map((p) => String(p._id)) }, isDelete: false, status: 'active' })
        .select('productId price compareAtPrice')
        .lean();
      for (const v of variants) {
        const k = String(v.productId);
        if (!variantsByProduct.has(k)) variantsByProduct.set(k, []);
        variantsByProduct.get(k)!.push(v);
      }
      if (this.premium && typeof this.premium.getTerms === 'function') minGap = (await this.premium.getTerms()).minGapPercent;
    }

    for (const id of input.productIds) {
      const p = byId.get(id);
      if (!p) { skipped.push({ id, reason: 'Product not found in this store' }); continue; }
      const own: string[] = Array.isArray(p.campaignIds) ? p.campaignIds : [];
      if (input.action === 'premium_on') {
        const message = premiumGapViolation(input.percent!, variantsByProduct.get(id) ?? [], minGap);
        if (message) { skipped.push({ id, reason: message }); continue; }
        ops.push({ updateOne: { filter: { _id: id }, update: { $set: { premiumDiscountPercent: input.percent, premiumOptOut: false, campaignIds: [] } } } });
      } else if (input.action === 'premium_off') {
        ops.push({ updateOne: { filter: { _id: id }, update: { $set: { premiumDiscountPercent: null, premiumOptOut: true } } } });
      } else if (input.action === 'campaign_add') {
        if (!own.includes(campaignId!) && own.length >= MAX_CAMPAIGNS_PER_PRODUCT) { skipped.push({ id, reason: `A product can be in at most ${MAX_CAMPAIGNS_PER_PRODUCT} sales` }); continue; }
        ops.push({ updateOne: { filter: { _id: id }, update: { $addToSet: { campaignIds: campaignId }, $set: { premiumOptOut: true, premiumDiscountPercent: null } } } });
      } else {
        ops.push({ updateOne: { filter: { _id: id }, update: { $pull: { campaignIds: input.campaignId } } } });
      }
      updated.push(id);
    }

    if (ops.length) await productModel.bulkWrite(ops, { ordered: false });

    if (updated.length) {
      void this.activityLogService.log({
        storeId: input.storeId,
        category: 'products',
        action: 'offers_bulk_updated',
        description: `Bulk offers (${input.action}) applied to ${updated.length} product(s)${skipped.length ? `, ${skipped.length} skipped` : ''}`,
        actorId: sellerId,
        actorRole: 'seller',
        targetType: 'product',
        metadata: { action: input.action, percent: input.percent ?? null, campaignId: input.campaignId ?? null, count: updated.length },
      });
    }
    return { success: true, data: { updated, skipped } };
  }
}
