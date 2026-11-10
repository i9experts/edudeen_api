import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ProductStockService } from '../products/product-stock.service';
import { effectiveThreshold, isLowStock, parseThresholdInput } from './stock-threshold.util';

const SID = 'a'.repeat(24);
const PID = 'b'.repeat(24);

describe('isLowStock / effectiveThreshold', () => {
  it('uses 10 when nothing valid is stored', () => {
    for (const raw of [undefined, null, 'x', -1, 1001, 2.5]) expect(effectiveThreshold(raw)).toBe(10);
    expect(effectiveThreshold(5)).toBe(5);
    expect(effectiveThreshold(0)).toBe(0);
  });
  it('low = some stock but not above the limit; 0 stock is out, never low; limit 0 = never low', () => {
    expect(isLowStock(9, undefined)).toBe(true);
    expect(isLowStock(10, null)).toBe(true);
    expect(isLowStock(11, null)).toBe(false);
    expect(isLowStock(0, 10)).toBe(false);
    expect(isLowStock(9, 5)).toBe(false); // acceptance: threshold 5, stock 9
    expect(isLowStock(5, 5)).toBe(true);
    expect(isLowStock(1, 0)).toBe(false);
  });
  it('parseThresholdInput: whole 0..1000 or null, else undefined', () => {
    expect(parseThresholdInput(null)).toBeNull();
    expect(parseThresholdInput(0)).toBe(0);
    expect(parseThresholdInput(1000)).toBe(1000);
    for (const bad of [-1, 1001, 1.5, '5', undefined, NaN]) expect(parseThresholdInput(bad)).toBeUndefined();
  });
});

describe('cards, list and dashboard agree on a per-product threshold', () => {
  const lean = (rows: any[]) => ({ select: () => ({ lean: async () => rows }), lean: async () => rows });
  function build() {
    const prods = [
      { _id: 'p1', name: 'Custom 5', type: 'physical', lowStockThreshold: 5, status: 'active' },
      { _id: 'p2', name: 'Default', type: 'physical', status: 'active' },
    ];
    const variants = [{ productId: 'p1', stock: 9 }, { productId: 'p2', stock: 9 }];
    const repos: any = {
      productModel: { find: jest.fn(() => lean(prods)), aggregate: jest.fn().mockResolvedValue([]) },
      productVariantModel: { find: jest.fn(() => lean(variants)) },
      storeModel: { findOne: jest.fn().mockResolvedValue({ _id: 1 }), exists: jest.fn().mockResolvedValue({ _id: 1 }) },
    };
    return new InventoryService({ repositories: repos } as any);
  }
  it('stock 9 with limit 5 is not low; the default product is', async () => {
    const svc: any = build();
    const stats: any = await svc.computeStockStats('st', 'se');
    expect(stats.lowStock).toBe(1);
    expect(stats.inStock).toBe(1);
    const summary: any = await svc.getLowStockSummary('se', 'st');
    expect(summary.data.count).toBe(1);
    expect(summary.data.items[0].name).toBe('Default');
  });
});

describe('setLowStockThreshold', () => {
  function build(matched = 1, owns = true) {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: matched });
    const repos: any = { productModel: { updateOne }, storeModel: { exists: jest.fn().mockResolvedValue(owns ? { _id: 1 } : null) } };
    return { svc: new InventoryService({ repositories: repos } as any), updateOne };
  }
  it('saves a valid limit scoped to the seller store; null clears it', async () => {
    const { svc, updateOne } = build();
    const r: any = await svc.setLowStockThreshold('se', SID, PID, 5);
    expect(updateOne.mock.calls[0][0]).toMatchObject({ _id: PID, storeId: SID, sellerId: 'se', isDelete: false });
    expect(r.data).toMatchObject({ lowStockThreshold: 5, hasCustomThreshold: true });
    const c: any = await svc.setLowStockThreshold('se', SID, PID, null);
    expect(c.data).toMatchObject({ lowStockThreshold: 10, hasCustomThreshold: false });
  });
  it('bad value 400, other seller 403, unknown product 404', async () => {
    await expect(build().svc.setLowStockThreshold('se', SID, PID, 1001)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(1, false).svc.setLowStockThreshold('x', SID, PID, 5)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(build(0).svc.setLowStockThreshold('se', SID, PID, 5)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('stock history', () => {
  function histSvc(owns = true, productExists = true, rows: any[] = []) {
    const limit = jest.fn(() => ({ lean: async () => rows }));
    const historyModel: any = { find: jest.fn(() => ({ sort: () => ({ limit }) })) };
    const repos: any = {
      storeModel: { exists: jest.fn().mockResolvedValue(owns ? { _id: 1 } : null) },
      productModel: { exists: jest.fn().mockResolvedValue(productExists ? { _id: 1 } : null) },
    };
    return { svc: new InventoryService({ repositories: repos } as any, undefined, undefined, historyModel), historyModel, limit };
  }
  it('returns the newest 20 of this store+product only', async () => {
    const { svc, historyModel, limit } = histSvc(true, true, [{ _id: 'h1', old: 5, new: 8, source: 'manual', createdAt: new Date() }]);
    const r: any = await svc.getStockHistory('se', SID, PID, '999');
    expect(historyModel.find).toHaveBeenCalledWith({ storeId: SID, productId: PID });
    expect(limit).toHaveBeenCalledWith(20);
    expect(r.data.items[0]).toMatchObject({ old: 5, new: 8, source: 'manual' });
  });
  it('other seller 403, product not in store 404', async () => {
    await expect(histSvc(false).svc.getStockHistory('x', SID, PID)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(histSvc(true, false).svc.getStockHistory('se', SID, PID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('manual stock endpoint writes one row per CHANGED variant (source manual); a failed write does not fail the save', async () => {
    const insertMany = jest.fn().mockResolvedValue([]);
    const lean = (rows: any[]) => ({ select: () => ({ lean: async () => rows }) });
    const repos: any = {
      storeModel: { exists: jest.fn().mockResolvedValue({ _id: 1 }), findOne: jest.fn().mockResolvedValue({ _id: 1 }) },
      productModel: { find: jest.fn(() => lean([{ _id: PID, name: 'P' }])) },
      productVariantModel: {
        find: jest.fn(() => lean([{ _id: 'c'.repeat(24), productId: PID, stock: 9 }, { _id: 'd'.repeat(24), productId: PID, stock: 4 }])),
        bulkWrite: jest.fn().mockResolvedValue({}),
      },
    };
    const svc = new ProductStockService({ repositories: repos } as any, { log: jest.fn() } as any, { insertMany } as any);
    const res: any = await svc.bulkUpdateStock('se', SID, [
      { variantId: 'c'.repeat(24), stock: 12 },
      { variantId: 'd'.repeat(24), stock: 4 }, // unchanged -> no row
    ]);
    expect(res.data.updated).toBe(2);
    const rows = insertMany.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ storeId: SID, productId: PID, old: 9, new: 12, source: 'manual', actorId: 'se' });

    insertMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.bulkUpdateStock('se', SID, [{ variantId: 'c'.repeat(24), stock: 13 }])).resolves.toBeTruthy();
  });
});
