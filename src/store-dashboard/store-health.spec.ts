import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { buildStoreHealth, countCancellations, parseHealthRange } from './store-health.util';
import { StoreHealthService } from './store-health.service';

const NOW = new Date('2026-11-05T12:00:00Z');
const H = 3_600_000;
const metric = (r: ReturnType<typeof buildStoreHealth>, id: string) => r.metrics.find((m) => m.id === id)!;

const pkgs = (onTime: number, late: number) => [
  ...Array.from({ length: onTime }, () => ({ baseAt: new Date(NOW.getTime() - 100 * H), shippedAt: new Date(NOW.getTime() - 90 * H), cancelled: false })),
  ...Array.from({ length: late }, () => ({ baseAt: new Date(NOW.getTime() - 100 * H), shippedAt: new Date(NOW.getTime() - 20 * H), cancelled: false })),
];
const inq = (n: number, replyMinutes: number | null) => Array.from({ length: n }, () => ({ inquiryAt: NOW.getTime() - 100 * H, replyMinutes }));
const base = { range: 30 as const, now: NOW, inquiries: [], packages: [], deliveredItems: 0, returnedItems: 0, rating: { average: 0, count: 0 }, sentBack: 0 };

describe('seller cancellation metric', () => {
  const p = (n: number, status: string, cancelledBy: string | null, eligible = true) =>
    Array.from({ length: n }, () => ({ eligible, status, cancelledBy }));

  it('counts only seller cancels over eligible packages', () => {
    const c = countCancellations([...p(8, 'completed', null), ...p(1, 'cancelled', 'seller'), ...p(1, 'cancelled', 'buyer'), ...p(3, 'cancelled', 'system', false)]);
    expect(c).toEqual({ eligible: 10, bySeller: 1 });
    const r = buildStoreHealth({ ...base, cancellation: c });
    expect(metric(r, 'cancellation').value).toBe(10);
    expect(metric(r, 'cancellation').status).toBe('attention');
    expect(metric(r, 'cancellation').countedFrom).toBeTruthy();
  });

  it('buyer and system cancels never hurt the seller; old docs without the field are not seller cancels', () => {
    const c = countCancellations([...p(8, 'cancelled', 'buyer'), ...p(1, 'cancelled', 'system'), ...p(1, 'cancelled', null)]);
    expect(c.bySeller).toBe(0);
    const m = metric(buildStoreHealth({ ...base, cancellation: c }), 'cancellation');
    expect(m.value).toBe(0);
    expect(m.status).toBe('good');
  });

  it('below 10 eligible packages shows no number', () => {
    const m = metric(buildStoreHealth({ ...base, cancellation: countCancellations(p(9, 'cancelled', 'seller')) }), 'cancellation');
    expect(m.value).toBeNull();
    expect(m.status).toBe('insufficient');
  });
});

describe('store health metric math', () => {
  it('range parsing accepts only 30 or 90', () => {
    expect(parseHealthRange(undefined)).toBe(30);
    expect(parseHealthRange('90')).toBe(90);
    expect(() => parseHealthRange('7')).toThrow(BadRequestException);
    expect(() => parseHealthRange('abc')).toThrow(BadRequestException);
  });

  it('new store: no numbers, flagged isNew, cancellation always unavailable', () => {
    const r = buildStoreHealth(base);
    expect(r.isNew).toBe(true);
    expect(metric(r, 'dispatch').status).toBe('insufficient');
    expect(metric(r, 'dispatch').value).toBeNull();
    expect(metric(r, 'cancellation').status).toBe('unavailable');
    expect(metric(r, 'sentBack').value).toBe(0);
  });

  it('below 10 samples shows no number (same minimum as the public strip)', () => {
    const r = buildStoreHealth({ ...base, packages: pkgs(5, 4), inquiries: inq(9, 30), rating: { average: 5, count: 9 }, deliveredItems: 9, returnedItems: 9 });
    for (const id of ['dispatch', 'responseRate', 'replyTime', 'rating', 'returns']) {
      expect(metric(r, id).value).toBeNull();
      expect(metric(r, id).status).toBe('insufficient');
    }
    expect(r.isNew).toBe(false);
  });

  it('late dispatch = 100 - on-time rate; 10% or less is good', () => {
    const good = buildStoreHealth({ ...base, packages: pkgs(18, 2) });
    expect(metric(good, 'dispatch')).toMatchObject({ value: 10, status: 'good', sample: 20 });
    const bad = buildStoreHealth({ ...base, packages: pkgs(15, 5) });
    expect(metric(bad, 'dispatch')).toMatchObject({ value: 25, status: 'attention' });
  });

  it('cancelled packages and unpaid ones are left out of dispatch', () => {
    const extra = [{ baseAt: null, shippedAt: null, cancelled: false }, { baseAt: new Date(NOW.getTime() - 100 * H), shippedAt: null, cancelled: true }];
    expect(metric(buildStoreHealth({ ...base, packages: [...pkgs(10, 0), ...extra] }), 'dispatch').sample).toBe(10);
  });

  it('return rate uses delivered items', () => {
    expect(metric(buildStoreHealth({ ...base, deliveredItems: 40, returnedItems: 2 }), 'returns')).toMatchObject({ value: 5, status: 'good' });
    expect(metric(buildStoreHealth({ ...base, deliveredItems: 20, returnedItems: 5 }), 'returns')).toMatchObject({ value: 25, status: 'attention' });
  });

  it('response rate + median reply time', () => {
    const r = buildStoreHealth({ ...base, inquiries: [...inq(9, 60), ...inq(1, 3000)] });
    expect(metric(r, 'responseRate')).toMatchObject({ value: 90, status: 'good' });
    expect(metric(r, 'replyTime')).toMatchObject({ value: 60, unit: 'minutes', status: 'good' });
    const slow = buildStoreHealth({ ...base, inquiries: inq(10, 2000) });
    expect(metric(slow, 'replyTime').status).toBe('attention');
    expect(metric(slow, 'responseRate')).toMatchObject({ value: 0, status: 'attention' });
  });

  it('rating needs 10 reviews, target 4.0', () => {
    expect(metric(buildStoreHealth({ ...base, rating: { average: 4.46, count: 12 } }), 'rating')).toMatchObject({ value: 4.5, status: 'good' });
    expect(metric(buildStoreHealth({ ...base, rating: { average: 3.2, count: 12 } }), 'rating').status).toBe('attention');
  });

  it('every metric carries sampleSize and minSample (additive)', () => {
    const r = buildStoreHealth({ ...base, packages: pkgs(5, 0), sentBack: 2 });
    expect(metric(r, 'dispatch')).toMatchObject({ sampleSize: 5, minSample: 10 });
    expect(metric(r, 'rating')).toMatchObject({ sampleSize: 0, minSample: 10 });
    expect(metric(r, 'sentBack')).toMatchObject({ sampleSize: 2, minSample: 0 });
  });

  it('sent back listings: 0 is good, more needs attention', () => {
    expect(metric(buildStoreHealth({ ...base, sentBack: 2 }), 'sentBack')).toMatchObject({ value: 2, status: 'attention' });
  });
});

describe('StoreHealthService ownership + cache', () => {
  function build(storeFound: boolean, cached?: string) {
    const lean = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });
    const storeModel = { findOne: jest.fn().mockReturnValue(lean(storeFound ? { averageRating: 4.5, reviewCount: 3 } : null)) };
    const aggregate = () => ({ allowDiskUse: () => Promise.resolve([]) });
    const db: any = {
      repositories: {
        storeModel,
        conversationModel: { find: () => lean([]) },
        messageModel: { aggregate },
        orderModel: { aggregate },
        productModel: {
          countDocuments: jest.fn().mockResolvedValue(0),
          find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }) }),
        },
      },
    };
    const redis: any = { get: jest.fn().mockResolvedValue(cached ?? null), set: jest.fn().mockResolvedValue(undefined) };
    return { svc: new StoreHealthService(db, redis), storeModel, redis, db };
  }

  it('refuses a store that is not the seller\'s own (query scoped by sellerId)', async () => {
    const { svc, storeModel, redis } = build(false);
    await expect(svc.getHealth('seller1', 'store1', 30)).rejects.toBeInstanceOf(ForbiddenException);
    expect(storeModel.findOne).toHaveBeenCalledWith({ _id: 'store1', sellerId: 'seller1', isDelete: false });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('computes, scopes the sent-back count to the store, and caches 15 minutes', async () => {
    const { svc, redis, db } = build(true);
    const r = await svc.getHealth('seller1', 'store1', 90, NOW);
    expect(r.range).toBe(90);
    expect(r.isNew).toBe(false); // 3 reviews = some evidence
    expect(db.repositories.productModel.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'store1', sellerId: 'seller1', status: 'rejected' }));
    expect(redis.set).toHaveBeenCalledWith('store-health:store1:90:d2', expect.any(String), 900);
  });

  it('serves a cached copy only after the ownership check', async () => {
    const { svc, db } = build(true, JSON.stringify({ range: 30, cached: true }));
    expect(await svc.getHealth('seller1', 'store1', 30)).toEqual({ range: 30, cached: true });
    expect(db.repositories.productModel.countDocuments).not.toHaveBeenCalled();
  });
});
