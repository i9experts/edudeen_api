import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProductStockService, normaliseStockUpdates } from './product-stock.service';

const V1 = '64b000000000000000000001';
const V2 = '64b000000000000000000002';
const P1 = '64b0000000000000000000a1';
const P2 = '64b0000000000000000000a2';
const STORE = '64b0000000000000000000f1';
const SELLER = '64b0000000000000000000e1';

describe('normaliseStockUpdates', () => {
  it('accepts whole numbers and de-duplicates by variant (last wins)', () => {
    expect(
      normaliseStockUpdates([
        { variantId: V1, stock: 3 },
        { variantId: V1, stock: 9 },
        { variantId: V2, stock: 0 },
      ]),
    ).toEqual([
      { variantId: V1, stock: 9 },
      { variantId: V2, stock: 0 },
    ]);
  });

  it.each([
    [undefined],
    [[]],
    [[{ variantId: 'nope', stock: 1 }]],
    [[{ variantId: V1, stock: -1 }]],
    [[{ variantId: V1, stock: 1.5 }]],
    [[{ variantId: V1, stock: '5' }]],
    [[{ variantId: V1, stock: 10_000_000 }]],
  ])('rejects invalid payload %j', raw => {
    expect(() => normaliseStockUpdates(raw)).toThrow(BadRequestException);
  });
});

describe('ProductStockService.bulkUpdateStock', () => {
  function build(opts: { storeOwned?: boolean } = {}) {
    const bulkWrite = jest.fn().mockResolvedValue({});
    const chain = (rows: any[]) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });
    const repos = {
      storeModel: { findOne: jest.fn().mockResolvedValue(opts.storeOwned === false ? null : { _id: STORE }) },
      productVariantModel: {
        find: jest.fn().mockReturnValue(
          chain([
            { _id: V1, productId: P1, stock: 4, unlimitedStock: false },
            { _id: V2, productId: P2, stock: 1, unlimitedStock: true },
          ]),
        ),
        bulkWrite,
      },
      // Only P1 belongs to this store; P2 is "someone else's" and must be skipped.
      productModel: { find: jest.fn().mockReturnValue(chain([{ _id: P1, name: 'A' }])) },
    };
    const log = jest.fn();
    const svc = new ProductStockService({ repositories: repos } as any, { log } as any);
    return { svc, repos, bulkWrite, log };
  }

  it('applies an atomic $set per owned variant, skips foreign ones and logs', async () => {
    const { svc, bulkWrite, log } = build();
    const res = await svc.bulkUpdateStock(SELLER, STORE, [
      { variantId: V1, stock: 12 },
      { variantId: V2, stock: 5 },
    ]);
    expect(res.data.updated).toBe(1);
    expect(res.data.skipped).toEqual([{ variantId: V2, reason: 'not_found' }]);
    expect(bulkWrite).toHaveBeenCalledWith(
      [{ updateOne: { filter: { _id: V1, isDelete: false }, update: { $set: { stock: 12 } } } }],
      { ordered: false },
    );
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE, category: 'products', action: 'stock_bulk_updated' }));
  });

  it('rejects a store the seller does not own', async () => {
    const { svc, bulkWrite } = build({ storeOwned: false });
    await expect(svc.bulkUpdateStock(SELLER, STORE, [{ variantId: V1, stock: 1 }])).rejects.toBeInstanceOf(ForbiddenException);
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it('rejects a bad storeId', async () => {
    const { svc } = build();
    await expect(svc.bulkUpdateStock(SELLER, 'x', [{ variantId: V1, stock: 1 }])).rejects.toBeInstanceOf(BadRequestException);
  });
});
