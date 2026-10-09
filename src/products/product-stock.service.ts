import { BadRequestException, Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
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

@Injectable()
export class ProductStockService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

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
}
