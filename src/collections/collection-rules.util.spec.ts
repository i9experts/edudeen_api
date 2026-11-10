import { BadRequestException } from '@nestjs/common';
import {
  cleanCollectionRules, cleanCollectionSort, cleanCollectionWindow, collectionWindowState,
  evaluateCollectionIds, liveWindowClause,
} from './collection-rules.util';

describe('cleanCollectionRules', () => {
  it('accepts empty / legacy rules', () => {
    const r = cleanCollectionRules({ categoryId: 'c', tags: ['a'], matchType: 'all' });
    expect(r).toMatchObject({ categoryId: 'c', tags: ['a'], matchType: 'all', priceMin: null, hasDiscount: false });
    expect(cleanCollectionRules(undefined).matchType).toBe('any');
  });
  it('min price > max price = 400', () => {
    expect(() => cleanCollectionRules({ priceMin: 500, priceMax: 100 })).toThrow(BadRequestException);
  });
  it('rejects out-of-range values', () => {
    expect(() => cleanCollectionRules({ priceMin: -1 })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ minRating: 6 })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ minRating: 0 })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ createdWithinDays: 0 })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ createdWithinDays: 400 })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ createdWithinDays: 2.5 })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ bestSellersTopN: 101 })).toThrow(BadRequestException);
  });
  it('rejects bad enums and class order', () => {
    expect(() => cleanCollectionRules({ language: 'fr' })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ matchType: 'some' })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ classFrom: 'class-9', classTo: 'class-3' })).toThrow(BadRequestException);
    expect(() => cleanCollectionRules({ classFrom: 'banana' })).toThrow(BadRequestException);
  });
  it('one-ended class range becomes a single class', () => {
    const r = cleanCollectionRules({ classFrom: 'class-3' });
    expect(r.classFrom).toBe('class-3');
    expect(r.classTo).toBe('class-3');
  });
  it('sort + schedule validation', () => {
    expect(cleanCollectionSort(undefined)).toBe('manual');
    expect(cleanCollectionSort('rating')).toBe('rating');
    expect(() => cleanCollectionSort('random')).toThrow(BadRequestException);
    expect(() => cleanCollectionWindow('2026-12-10', '2026-12-01')).toThrow(BadRequestException);
    expect(() => cleanCollectionWindow('nope', null)).toThrow(BadRequestException);
    expect(cleanCollectionWindow(null, null)).toEqual({ startAt: null, endAt: null });
  });
});

describe('collection window', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  it('scheduled before start, live inside, ended after', () => {
    expect(collectionWindowState({ startAt: '2026-11-11T00:00:00Z' }, now)).toBe('scheduled');
    expect(collectionWindowState({ startAt: '2026-11-09T00:00:00Z', endAt: '2026-11-12T00:00:00Z' }, now)).toBe('live');
    expect(collectionWindowState({ endAt: '2026-11-10T12:00:00Z' }, now)).toBe('ended');
    expect(collectionWindowState({}, now)).toBe('live');
  });
  it('public clause treats missing dates as open', () => {
    const c = liveWindowClause(now) as any;
    expect(c.$and[0].$or).toEqual([{ startAt: null }, { startAt: { $lte: now } }]);
    expect(c.$and[1].$or).toEqual([{ endAt: null }, { endAt: { $gt: now } }]);
  });
});

function repos(products: any[], variants: any[]) {
  const finds: any[] = [];
  return {
    finds,
    productModel: {
      find: jest.fn((filter: any) => {
        finds.push(filter);
        const chain: any = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => products };
        return chain;
      }),
    },
    productVariantModel: {
      // mimic the grouped aggregate the evaluator asks for
      aggregate: jest.fn(async () => {
        const g = new Map<string, any>();
        for (const v of variants) {
          const cur = g.get(v.productId) ?? { _id: v.productId, min: Infinity, disc: 0 };
          cur.min = Math.min(cur.min, v.price);
          if (v.compareAtPrice > v.price) cur.disc = 1;
          g.set(v.productId, cur);
        }
        return [...g.values()];
      }),
    },
  };
}
const P = (id: string, extra: any = {}) => ({ _id: id, createdAt: new Date(2026, 0, Number(id.slice(-1)) || 1), purchaseCount: 0, averageRating: 0, ...extra });

describe('evaluateCollectionIds', () => {
  it('always excludes inactive / deleted / test products in the query', async () => {
    const r = repos([P('p1')], []);
    await evaluateCollectionIds(r as any, 's', { type: 'automatic', rules: {} });
    expect(r.finds[0]).toMatchObject({ storeId: 's', isDelete: false, status: 'active', isTest: { $ne: true } });
    const m = repos([P('p1')], []);
    await evaluateCollectionIds(m as any, 's', { type: 'manual', productIds: ['p1'] });
    expect(m.finds[0]).toMatchObject({ isDelete: false, status: 'active', isTest: { $ne: true }, _id: { $in: ['p1'] } });
  });
  it('manual collection keeps the seller order', async () => {
    const r = repos([P('p1'), P('p2'), P('p3')], []);
    const ids = await evaluateCollectionIds(r as any, 's', { type: 'manual', productIds: ['p3', 'p1', 'p2'], sortBy: 'manual' });
    expect(ids).toEqual(['p3', 'p1', 'p2']);
  });
  it('price range uses the cheapest active variant', async () => {
    const r = repos([P('p1'), P('p2'), P('p3')], [
      { productId: 'p1', price: 100 }, { productId: 'p1', price: 900 },
      { productId: 'p2', price: 400 }, { productId: 'p3', price: 1200 },
    ]);
    const ids = await evaluateCollectionIds(r as any, 's', { type: 'automatic', rules: { priceMin: 200, priceMax: 1000 } as any, sortBy: 'price_asc' });
    expect(ids).toEqual(['p2']); // p1 cheapest = 100 (out), p3 = 1200 (out)
  });
  it('hasDiscount keeps only compare-at > price products', async () => {
    const r = repos([P('p1'), P('p2')], [
      { productId: 'p1', price: 100, compareAtPrice: 150 }, { productId: 'p2', price: 100, compareAtPrice: null },
    ]);
    expect(await evaluateCollectionIds(r as any, 's', { type: 'automatic', rules: { hasDiscount: true } as any })).toEqual(['p1']);
  });
  it('best sellers top N takes the highest purchaseCount', async () => {
    const r = repos([P('p1', { purchaseCount: 5 }), P('p2', { purchaseCount: 50 }), P('p3', { purchaseCount: 20 })], []);
    const ids = await evaluateCollectionIds(r as any, 's', { type: 'automatic', rules: { bestSellersTopN: 2 } as any, sortBy: 'best_selling' });
    expect(ids).toEqual(['p2', 'p3']);
    expect(r.finds[0].$and).toEqual(expect.arrayContaining([{ purchaseCount: { $gt: 0 } }]));
  });
  it('sorts: newest, rating, price high-low', async () => {
    const prods = [P('p1', { averageRating: 3 }), P('p2', { averageRating: 5 }), P('p3', { averageRating: 4 })];
    const vars = [{ productId: 'p1', price: 10 }, { productId: 'p2', price: 30 }, { productId: 'p3', price: 20 }];
    expect(await evaluateCollectionIds(repos(prods, vars) as any, 's', { type: 'automatic', rules: {}, sortBy: 'newest' })).toEqual(['p3', 'p2', 'p1']);
    expect(await evaluateCollectionIds(repos(prods, vars) as any, 's', { type: 'automatic', rules: {}, sortBy: 'rating' })).toEqual(['p2', 'p3', 'p1']);
    expect(await evaluateCollectionIds(repos(prods, vars) as any, 's', { type: 'automatic', rules: {}, sortBy: 'price_desc' })).toEqual(['p2', 'p3', 'p1']);
  });
  it('builds the new filter clauses', async () => {
    const r = repos([], []);
    await evaluateCollectionIds(r as any, 's', { type: 'automatic', rules: { minRating: 4, language: 'ur', createdWithinDays: 30, classFrom: 'class-3', classTo: 'class-4' } as any });
    const and = r.finds[0].$and;
    expect(and).toEqual(expect.arrayContaining([{ averageRating: { $gte: 4 } }, { language: 'ur' }]));
    expect(and.some((c: any) => c.createdAt?.$gte instanceof Date)).toBe(true);
    expect(and.some((c: any) => Array.isArray(c.$or) && c.$or.length === 2)).toBe(true);
  });
  it('same evaluator = same ids for count, preview and tab (deterministic)', async () => {
    const prods = [P('p1'), P('p2'), P('p3')];
    const col: any = { type: 'automatic', rules: {}, sortBy: 'newest' };
    const a = await evaluateCollectionIds(repos(prods, []) as any, 's', col);
    const b = await evaluateCollectionIds(repos(prods, []) as any, 's', col);
    expect(a).toEqual(b);
  });
});
