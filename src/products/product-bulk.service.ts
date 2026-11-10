/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { PremiumEntitlementsService } from '../premium/premium-entitlements.service';
import { assertPremiumGap } from '../premium/premium-gap';
import { assertPriceRules } from './price-rules.util';
import { planVisibilityChange } from './product-lifecycle.service';

export const MAX_BULK_PRODUCTS = 100;
export const MAX_PERCENT_UP = 300;
export const MAX_PERCENT_DOWN = -90;

/** Shape check for the shared `ids` array (pure). Throws 400. */
export function normaliseIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('ids must be a non-empty array');
  if (raw.length > MAX_BULK_PRODUCTS) throw new BadRequestException(`At most ${MAX_BULK_PRODUCTS} products per request`);
  if (!raw.every((x) => typeof x === 'string' && isValidObjectId(x))) throw new BadRequestException('ids must be valid product ids');
  return [...new Set(raw as string[])];
}

export type PriceMode = 'set' | 'percent';

/** New price for one product (pure). PKR = whole rupees, other currencies 2 decimals. */
export function computeNewPrice(old: number, mode: PriceMode, value: number, currency?: string | null): number {
  const raw = mode === 'set' ? value : old * (1 + value / 100);
  if (currency === 'PKR') return Math.round(raw);
  return Math.round(raw * 100) / 100;
}

export interface PricePreviewItem { id: string; name: string; from: number | null; to: number | null; ok: boolean; unchanged?: boolean; reason?: string }

@Injectable()
export class ProductBulkService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlements: EntitlementsService,
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  /** Loads the products; ONE id that is missing, deleted or another seller's = 403 for the whole request, nothing changes. */
  private async loadOwned(sellerId: string, ids: string[]) {
    const { productModel } = this.databaseService.repositories;
    const products: any[] = await productModel.find({ _id: { $in: ids }, isDelete: false }).lean();
    const foreign = ids.some((id) => !products.find((p) => String(p._id) === id && String(p.sellerId) === String(sellerId)));
    if (foreign) throw new ForbiddenException('One or more products are not in your store. Nothing was changed.');
    return ids.map((id) => products.find((p) => String(p._id) === id));
  }

  /** PATCH bulk-status: the single-product Activate / Deactivate rules (planVisibilityChange) applied per item. */
  async bulkSetStatus(sellerId: string, body: any) {
    const ids = normaliseIds(body?.ids);
    if (typeof body?.active !== 'boolean') throw new BadRequestException('active must be true or false');
    const active: boolean = body.active;
    const { productModel } = this.databaseService.repositories;
    const products = await this.loadOwned(sellerId, ids);

    // A plan that ended blocks activating (once per store, same check as the single route).
    const planBlock = new Map<string, string>();
    if (active) {
      for (const storeId of new Set(products.map((p) => String(p.storeId)))) {
        try { await this.entitlements.assertCanCreateProduct(storeId); }
        catch (e: any) { planBlock.set(storeId, e?.message || 'Your plan does not allow activating products right now.'); }
      }
    }

    const updated: { id: string; name: string; status: string }[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    const ops: any[] = [];
    for (const p of products) {
      const id = String(p._id);
      const plan = planVisibilityChange(p, active);
      if (plan.ok === false) { skipped.push({ id, name: p.name, reason: plan.message }); continue; }
      if (active && planBlock.has(String(p.storeId))) { skipped.push({ id, name: p.name, reason: planBlock.get(String(p.storeId))! }); continue; }
      ops.push({ updateOne: { filter: { _id: id, sellerId, isDelete: false, status: plan.from, pausedFromStatus: null }, update: { $set: { status: plan.to } } } });
      updated.push({ id, name: p.name, status: plan.to });
    }
    let modified = updated.length;
    if (ops.length) {
      const res: any = await productModel.bulkWrite(ops, { ordered: false });
      modified = res?.modifiedCount ?? res?.nModified ?? updated.length;
    }
    await this.activityLogService.log({
      storeId: String(products[0].storeId), category: 'products', action: active ? 'products_bulk_activated' : 'products_bulk_deactivated',
      description: `${updated.length} product(s) ${active ? 'activated' : 'deactivated'} in bulk${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      actorId: sellerId, actorRole: 'seller', targetType: 'product',
      metadata: { updated: updated.slice(0, 100), skipped: skipped.slice(0, 100).map((s) => ({ id: s.id, reason: s.reason })) },
    } as any);
    return {
      success: true,
      message: `${updated.length} product${updated.length === 1 ? '' : 's'} ${active ? 'activated' : 'deactivated'}${skipped.length ? `, ${skipped.length} skipped` : ''}.`,
      data: { updated, skipped, changedMeanwhile: Math.max(0, updated.length - modified) },
    };
  }

  /**
   * PATCH bulk-price: EVERY item is validated first (one variant, price rules, free only when already free, Premium gap).
   * Any failure = 400 with per-item reasons and nothing changes; `dryRun` returns the same list as a 200 preview.
   */
  async bulkSetPrice(sellerId: string, body: any) {
    const ids = normaliseIds(body?.ids);
    const mode = body?.mode as PriceMode;
    if (mode !== 'set' && mode !== 'percent') throw new BadRequestException('mode must be set or percent');
    const value = body?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestException('value must be a number');
    if (mode === 'set' && value < 0) throw new BadRequestException("Price can't be negative");
    if (mode === 'percent' && (value < MAX_PERCENT_DOWN || value > MAX_PERCENT_UP)) throw new BadRequestException(`Percent must be between ${MAX_PERCENT_DOWN} and +${MAX_PERCENT_UP}`);
    const dryRun = body?.dryRun === true;

    const { productVariantModel, storeModel } = this.databaseService.repositories;
    const products = await this.loadOwned(sellerId, ids);
    const storeIds = [...new Set(products.map((p) => String(p.storeId)))];
    const stores: any[] = await storeModel.find({ _id: { $in: storeIds }, isDelete: false }).select('baseCurrency premiumDiscount').lean();
    const storeById = new Map<string, any>(stores.map((s) => [String(s._id), s]));
    const variants: any[] = await productVariantModel.find({ productId: { $in: ids }, isDelete: false }).select('productId price compareAtPrice').lean();
    const variantsByProduct = new Map<string, any[]>();
    for (const v of variants) {
      const k = String(v.productId);
      if (!variantsByProduct.has(k)) variantsByProduct.set(k, []);
      variantsByProduct.get(k)!.push(v);
    }

    const items: PricePreviewItem[] = [];
    const ops: any[] = [];
    for (const p of products) {
      const id = String(p._id);
      const vs = variantsByProduct.get(id) ?? [];
      const fail = (reason: string, from: number | null = null) => items.push({ id, name: p.name, from, to: null, ok: false, reason });
      if (p.deliveryFormat === 'course') { fail('Online course - change its price on the Edit page.'); continue; }
      if (vs.length !== 1) { fail(vs.length === 0 ? 'No price found for this product.' : `Has ${vs.length} variants - change prices on the Edit page.`); continue; }
      const v = vs[0];
      const old = Number(v.price);
      const store = storeById.get(String(p.storeId));
      const to = computeNewPrice(old, mode, value, store?.baseCurrency);
      if (to === old) { items.push({ id, name: p.name, from: old, to, ok: true, unchanged: true }); continue; }
      if (to <= 0 && old !== 0) { fail(to < 0 ? "Price can't be negative." : 'Would make the product free. To give it away, set it to free in the Edit page.', old); continue; }
      if (to === 0 && old === 0) { items.push({ id, name: p.name, from: old, to, ok: true, unchanged: true }); continue; }
      try {
        assertPriceRules({ price: to, compareAtPrice: v.compareAtPrice, currency: store?.baseCurrency });
        await assertPremiumGap(this.premium, store, p.premiumDiscountPercent, [{ price: to, compareAtPrice: v.compareAtPrice }], p.premiumOptOut === true);
      } catch (e: any) { fail(e?.message || 'Price not allowed.', old); continue; }
      items.push({ id, name: p.name, from: old, to, ok: true });
      ops.push({ updateOne: { filter: { _id: v._id, isDelete: false }, update: { $set: { price: to } } } });
    }

    const failed = items.filter((i) => !i.ok);
    const changes = items.filter((i) => i.ok && !i.unchanged);
    if (dryRun) return { success: true, data: { dryRun: true, canApply: failed.length === 0 && changes.length > 0, items } };
    if (failed.length) {
      const names = failed.slice(0, 3).map((f) => `"${f.name}" - ${f.reason}`).join(' | ');
      throw new BadRequestException({ success: false, message: `Nothing was changed. ${failed.length} product${failed.length === 1 ? '' : 's'} can't take this price: ${names}${failed.length > 3 ? ` (+${failed.length - 3} more)` : ''}`, items });
    }
    if (ops.length) await productVariantModel.bulkWrite(ops, { ordered: false });
    await this.activityLogService.log({
      storeId: String(products[0].storeId), category: 'products', action: 'products_bulk_price_updated',
      description: `Price changed on ${changes.length} product(s) (${mode === 'set' ? `set to ${value}` : `${value > 0 ? '+' : ''}${value}%`})`,
      actorId: sellerId, actorRole: 'seller', targetType: 'product',
      metadata: { mode, value, changes: changes.slice(0, 100).map((c) => ({ id: c.id, from: c.from, to: c.to })) },
    } as any);
    return { success: true, message: `Price updated on ${changes.length} product${changes.length === 1 ? '' : 's'}.`, data: { dryRun: false, items } };
  }
}
