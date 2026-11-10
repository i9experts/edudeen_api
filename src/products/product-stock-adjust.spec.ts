import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProductStockService, normaliseStockAdjust, planStockAdjust } from './product-stock.service';

const P1 = '64b0000000000000000000a1';
const P2 = '64b0000000000000000000a2';
const P3 = '64b0000000000000000000a3';
const PD = '64b0000000000000000000a4'; // digital
const PX = '64b0000000000000000000a5'; // foreign
const STORE = '64b0000000000000000000f1';
const OTHER_STORE = '64b0000000000000000000f2';
const SELLER = '64b0000000000000000000e1';

describe('normaliseStockAdjust / planStockAdjust', () => {
  it('validates the payload', () => {
    expect(normaliseStockAdjust({ ids: [P1, P1, P2], mode: 'set', value: 20 })).toEqual({ ids: [P1, P2], mode: 'set', value: 20 });
    for (const bad of [
      { ids: [], mode: 'set', value: 1 },
      { ids: ['x'], mode: 'set', value: 1 },
      { ids: [P1], mode: 'mul', value: 1 },
      { ids: [P1], mode: 'set', value: -1 },
      { ids: [P1], mode: 'set', value: 1.5 },
      { ids: [P1], mode: 'set', value: 100001 },
      { ids: Array.from({ length: 101 }, (_, i) => `64b${String(i).padStart(21, '0')}`), mode: 'set', value: 1 },
    ]) expect(() => normaliseStockAdjust(bad)).toThrow(BadRequestException);
  });

  it('never allows below 0 or above 100000', () => {
    expect(planStockAdjust(5, 'subtract', 6)).toMatchObject({ ok: false });
    expect(planStockAdjust(5, 'subtract', 5)).toEqual({ ok: true, to: 0 });
    expect(planStockAdjust(99_990, 'add', 11)).toMatchObject({ ok: false });
    expect(planStockAdjust(1, 'add', 4)).toEqual({ ok: true, to: 5 });
    expect(planStockAdjust(1, 'set', 100_000)).toEqual({ ok: true, to: 100_000 });
  });
});

describe('ProductStockService.bulkAdjustStock', () => {
  function build(opts: { raceOn?: string } = {}) {
    const lean = (rows: any) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });
    const products = [
      { _id: P1, name: 'A', type: 'physical', storeId: STORE, sellerId: SELLER },
      { _id: P2, name: 'B', type: 'physical', storeId: STORE, sellerId: SELLER },
      { _id: P3, name: 'C', type: 'physical', storeId: STORE, sellerId: SELLER },
      { _id: PD, name: 'D', type: 'digital', storeId: STORE, sellerId: SELLER },
      { _id: PX, name: 'X', type: 'physical', storeId: OTHER_STORE, sellerId: 'someone-else' },
    ];
    const variants = [
      { _id: 'v1', productId: P1, stock: 4, unlimitedStock: false },
      { _id: 'v2', productId: P2, stock: 7, unlimitedStock: false },
      { _id: 'v3', productId: P3, stock: 0, unlimitedStock: true },
      { _id: 'vd', productId: PD, stock: 0, unlimitedStock: true },
    ];
    const findOneAndUpdate = jest.fn().mockImplementation((filter: any) => ({
      select: () => ({ lean: () => Promise.resolve(opts.raceOn === filter._id ? null : { stock: filter.stock }) }),
    }));
    const repos = {
      storeModel: { findOne: jest.fn().mockResolvedValue({ _id: STORE }) },
      productModel: { find: jest.fn().mockImplementation((q: any) => lean(products.filter((p) => q._id.$in.includes(p._id)))) },
      productVariantModel: {
        find: jest.fn().mockImplementation((q: any) => lean(variants.filter((v) => q.productId.$in.includes(v.productId)))),
        findOneAndUpdate,
      },
    };
    const log = jest.fn().mockResolvedValue(true);
    return { svc: new ProductStockService({ repositories: repos } as any, { log } as any), findOneAndUpdate, log };
  }

  it('sets stock on physical products, skips digital/unlimited, one audit entry each', async () => {
    const { svc, findOneAndUpdate, log } = build();
    const res: any = await svc.bulkAdjustStock(SELLER, STORE, { ids: [P1, P2, P3, PD], mode: 'set', value: 20 });
    expect(res.data.updated).toEqual([{ id: P1, name: 'A', from: 4, to: 20 }, { id: P2, name: 'B', from: 7, to: 20 }]);
    expect(res.data.skipped.map((s: any) => s.code)).toEqual(['unlimited', 'digital']);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'v1', stock: 4 });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'stock_adjusted', actorId: SELLER, targetId: P1, metadata: expect.objectContaining({ from: 4, to: 20 }) }));
  });

  it('a foreign id = 403 and nothing is written', async () => {
    const { svc, findOneAndUpdate, log } = build();
    await expect(svc.bulkAdjustStock(SELLER, STORE, { ids: [P1, PX], mode: 'set', value: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.bulkAdjustStock(SELLER, STORE, { ids: [P1, '64b0000000000000000000ff'], mode: 'set', value: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('subtract below 0 is skipped with a reason; a lost race is skipped, not logged', async () => {
    const a = build();
    const r1: any = await a.svc.bulkAdjustStock(SELLER, STORE, { ids: [P1, P2], mode: 'subtract', value: 5 });
    expect(r1.data.updated).toEqual([{ id: P2, name: 'B', from: 7, to: 2 }]);
    expect(r1.data.skipped[0]).toMatchObject({ id: P1, code: 'range' });

    const b = build({ raceOn: 'v1' });
    const r2: any = await b.svc.bulkAdjustStock(SELLER, STORE, { ids: [P1], mode: 'add', value: 1 });
    expect(r2.data.updated).toEqual([]);
    expect(r2.data.skipped[0]).toMatchObject({ code: 'changed' });
    expect(b.log).not.toHaveBeenCalled();
  });
});
