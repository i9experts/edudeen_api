import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { StockHistory } from '../inventory/stock-history.schema';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';

export const MAX_BULK_STOCK_UPDATES = 200;
export const MAX_STOCK_VALUE = 1_000_000;

export interface StockUpdateInput {
  variantId: string;
  stock: number;
}

/**
 * Validates and de-duplicates a bulk stock payload (last value wins per
 * variant). Pure so it can be unit tested without a database.
 */
export function normaliseStockUpdates(raw: unknown): StockUpdateInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException('updates must be a non-empty array');
  }
  if (raw.length > MAX_BULK_STOCK_UPDATES) {
    throw new BadRequestException(`At most ${MAX_BULK_STOCK_UPDATES} updates per request`);
  }
  const byVariant = new Map<string, number>();
  for (const item of raw) {
    const variantId = typeof item?.variantId === 'string' ? item.variantId : '';
    const stock = item?.stock;
    if (!isValidObjectId(variantId)) {
      throw new BadRequestException('Invalid variantId');
    }
    if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK_VALUE) {
      throw new BadRequestException(`stock must be a whole number between 0 and ${MAX_STOCK_VALUE}`);
    }
    byVariant.set(variantId, stock);
  }
  return [...byVariant.entries()].map(([variantId, stock]) => ({ variantId, stock }));
}

export const MAX_BULK_ADJUST_PRODUCTS = 100;
export const MAX_ADJUST_STOCK = 100_000;
export type StockAdjustMode = 'set' | 'add' | 'subtract';

/** Shape check for the product-level bulk stock adjust (pure). Throws 400. */
export function normaliseStockAdjust(body: any): { ids: string[]; mode: StockAdjustMode; value: number } {
  const raw = body?.ids;
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('ids must be a non-empty array');
  if (raw.length > MAX_BULK_ADJUST_PRODUCTS) throw new BadRequestException(`At most ${MAX_BULK_ADJUST_PRODUCTS} products per request`);
  if (!raw.every((x) => typeof x === 'string' && isValidObjectId(x))) throw new BadRequestException('ids must be valid product ids');
  const mode = body?.mode;
  if (mode !== 'set' && mode !== 'add' && mode !== 'subtract') throw new BadRequestException('mode must be set, add or subtract');
  const value = body?.value;
  if (!Number.isInteger(value) || value < 0 || value > MAX_ADJUST_STOCK) {
    throw new BadRequestException(`value must be a whole number between 0 and ${MAX_ADJUST_STOCK}`);
  }
  return { ids: [...new Set(raw as string[])], mode, value };
}

/** New stock for one variant, or the reason it cannot change (pure). */
export function planStockAdjust(current: number, mode: StockAdjustMode, value: number): { ok: true; to: number } | { ok: false; reason: string } {
  const to = mode === 'set' ? value : mode === 'add' ? current + value : current - value;
  if (to < 0) return { ok: false, reason: `Would go below 0 (has ${current}).` };
  if (to > MAX_ADJUST_STOCK) return { ok: false, reason: `Would go above ${MAX_ADJUST_STOCK}.` };
  return { ok: true, to };
}

@Injectable()
export class ProductStockService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    @Optional() @InjectModel(StockHistory.name) private readonly historyModel?: Model<StockHistory>,
  ) {}

  /** Best effort: a failed history write must never undo or fail a stock change that already happened. */
  private async writeHistory(
    storeId: string,
    sellerId: string,
    source: 'manual' | 'bulk',
    rows: { productId: string; variantId: string; from: number; to: number }[],
  ) {
    const changed = rows.filter((r) => r.from !== r.to);
    if (!this.historyModel || !changed.length) return;
    try {
      await this.historyModel.insertMany(
        changed.map((r) => ({ productId: r.productId, variantId: r.variantId, storeId, old: r.from, new: r.to, source, actorId: sellerId })),
        { ordered: false },
      );
    } catch {
      /* history is a log, not part of the sale */
    }
  }

  /**
   * Sets the stock of several variants of ONE store the caller owns.
   * Each variant gets its own atomic $set (no read-modify-write); variants
   * that are unlimited-stock, deleted, or belong to another store are skipped
   * and reported back instead of failing the whole batch.
   */
  async bulkUpdateStock(sellerId: string, storeId: string, rawUpdates: unknown) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid storeId');
    const updates = normaliseStockUpdates(rawUpdates);

    const { storeModel, productModel, productVariantModel } = this.databaseService.repositories;
    await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

    const variants = await productVariantModel
      .find({ _id: { $in: updates.map(u => u.variantId) }, isDelete: false })
      .select('productId stock unlimitedStock')
      .lean();
    const variantById = new Map<string, any>(variants.map((v: any) => [String(v._id), v]));

    const productIds = [...new Set(variants.map((v: any) => String(v.productId)))];
    const ownedProducts = productIds.length
      ? await productModel
          .find({ _id: { $in: productIds }, storeId, sellerId, isDelete: false, type: { $ne: 'digital' } })
          .select('name')
          .lean()
      : [];
    const ownedProductName = new Map<string, string>(ownedProducts.map((p: any) => [String(p._id), p.name]));

    const applied: { variantId: string; productId: string; from: number; to: number }[] = [];
    const skipped: { variantId: string; reason: string }[] = [];
    const ops: any[] = [];

    for (const u of updates) {
      const v = variantById.get(u.variantId);
      if (!v || !ownedProductName.has(String(v.productId))) {
        skipped.push({ variantId: u.variantId, reason: 'not_found' });
        continue;
      }
      if (v.unlimitedStock) {
        skipped.push({ variantId: u.variantId, reason: 'unlimited_stock' });
        continue;
      }
      ops.push({ updateOne: { filter: { _id: u.variantId, isDelete: false }, update: { $set: { stock: u.stock } } } });
      applied.push({ variantId: u.variantId, productId: String(v.productId), from: v.stock ?? 0, to: u.stock });
    }

    if (ops.length) await productVariantModel.bulkWrite(ops, { ordered: false });
    await this.writeHistory(storeId, sellerId, 'manual', applied);

    if (applied.length) {
      void this.activityLogService.log({
        storeId,
        category: 'products',
        action: 'stock_bulk_updated',
        description: `Stock updated for ${applied.length} variant${applied.length === 1 ? '' : 's'}`,
        actorId: sellerId,
        actorRole: 'seller',
        targetType: 'product_variant',
        metadata: { changes: applied.slice(0, 50) },
      });
    }

    return { success: true, data: { updated: applied.length, skipped } };
  }

  /**
   * Seller Inventory bulk action on PRODUCT ids: set / add / subtract stock (whole numbers, 0..100000).
   * One id that is missing or not in this store = 403 for the whole request. Digital / unlimited / multi-variant
   * products are skipped with a reason. Each product is changed by ONE guarded atomic update (so a sale between
   * read and write cannot push stock below 0 or past the cap) and gets its own awaited audit entry (who, old, new).
   */
  async bulkAdjustStock(sellerId: string, storeId: string, body: any) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid storeId');
    const { ids, mode, value } = normaliseStockAdjust(body);
    const { storeModel, productModel, productVariantModel } = this.databaseService.repositories;
    await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

    const products: any[] = await (productModel as any).find({ _id: { $in: ids }, isDelete: false }).select('name type storeId sellerId deliveryFormat').lean();
    const foreign = ids.some((id) => !products.find((p) => String(p._id) === id && String(p.storeId) === storeId && String(p.sellerId) === String(sellerId)));
    if (foreign) throw new ForbiddenException('One or more products are not in your store. Nothing was changed.');

    const variants: any[] = await (productVariantModel as any).find({ productId: { $in: ids }, isDelete: false }).select('productId stock unlimitedStock').lean();
    const byProduct = new Map<string, any[]>();
    for (const v of variants) {
      const k = String(v.productId);
      if (!byProduct.has(k)) byProduct.set(k, []);
      byProduct.get(k)!.push(v);
    }

    const updated: { id: string; name: string; from: number; to: number }[] = [];
    const historyRows: { productId: string; variantId: string; from: number; to: number }[] = [];
    const skipped: { id: string; name: string; reason: string; code: string }[] = [];
    for (const id of ids) {
      const p = products.find((x) => String(x._id) === id)!;
      const skip = (code: string, reason: string) => skipped.push({ id, name: p.name, code, reason });
      const vs = byProduct.get(id) ?? [];
      if (p.type === 'digital') { skip('digital', 'Digital product - no stock to change.'); continue; }
      if (vs.length !== 1) { skip('variants', vs.length === 0 ? 'No stock record found.' : `Has ${vs.length} variants - change stock on the Edit page.`); continue; }
      const v = vs[0];
      if (v.unlimitedStock) { skip('unlimited', 'Unlimited stock - nothing to change.'); continue; }
      const current = Number(v.stock ?? 0);
      const plan = planStockAdjust(current, mode, value);
      if (plan.ok === false) { skip('range', plan.reason); continue; }
      if (plan.to === current) { skip('unchanged', 'Already that amount.'); continue; }

      // Atomic: the filter re-checks the value we planned from, so a concurrent sale = skipped, never a wrong number.
      const before: any = await (productVariantModel as any).findOneAndUpdate(
        { _id: v._id, isDelete: false, unlimitedStock: { $ne: true }, stock: current },
        { $set: { stock: plan.to } },
        { returnDocument: 'before' },
      ).select('stock').lean();
      if (!before) { skip('changed', 'Stock changed while saving - try again.'); continue; }
      updated.push({ id, name: p.name, from: current, to: plan.to });
      historyRows.push({ productId: id, variantId: String(v._id), from: current, to: plan.to });
    }
    await this.writeHistory(storeId, sellerId, 'bulk', historyRows);

    // One awaited audit entry per changed product (time = entry createdAt).
    await Promise.all(updated.map((u) => this.activityLogService.log({
      storeId,
      category: 'products',
      action: 'stock_adjusted',
      description: `Stock of "${u.name}" ${mode === 'set' ? 'set' : mode === 'add' ? 'increased' : 'reduced'}: ${u.from} -> ${u.to}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetType: 'product',
      targetId: u.id,
      metadata: { mode, value, from: u.from, to: u.to, bulk: true },
    } as any)));

    return { success: true, data: { updated, skipped } };
  }
}
