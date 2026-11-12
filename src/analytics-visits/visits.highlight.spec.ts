/* eslint-disable prettier/prettier */
import { VisitsService } from './visits.service';
import { highlightKey, parseHighlightKey, pktDateOf, sanitizeHighlightRow } from './visit-tracking.util';

const STORE = 'a'.repeat(24);
const OTHER_STORE = 'e'.repeat(24);
const PRODUCT = 'b'.repeat(24);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

class FakeRedis {
  isConnected = true;
  kv = new Map<string, string>();
  async setNx(k: string) { if (this.kv.has(k)) return false; this.kv.set(k, '1'); return true; }
  async incrBy(k: string, n: number) { this.kv.set(k, String(Number(this.kv.get(k) ?? 0) + n)); }
  async scanKeys(p: string) { const pre = p.replace('*', ''); return [...this.kv.keys()].filter((k) => k.startsWith(pre)); }
  async getDel(k: string) { const v = this.kv.get(k) ?? null; this.kv.delete(k); return v; }
}

function make() {
  const redis = new FakeRedis();
  const clickRows: any[] = [];
  const highlightModel: any = {
    bulkWrite: async (ops: any[]) => {
      for (const { updateOne: u } of ops) {
        const hit = clickRows.find((r) => Object.keys(u.filter).every((k) => r[k] === u.filter[k]));
        if (hit) hit.clicks += u.update.$inc.clicks; else clickRows.push({ ...u.filter, clicks: u.update.$inc.clicks });
      }
    },
  };
  const productModel: any = { findOne: () => ({ select: () => ({ lean: async () => ({ storeId: STORE }) }) }) };
  const storeModel: any = { find: (q: any) => ({ select: () => ({ lean: async () => [STORE].filter((s) => q._id.$in.includes(s)).map((s) => ({ _id: s })) }) }) };
  const svc = new VisitsService(redis as any, {} as any, {} as any, {} as any, productModel, storeModel, undefined, highlightModel);
  return { svc, redis, clickRows };
}
const click = (svc: VisitsService, over: Partial<{ ip: string; ua: string; row: unknown; id: unknown }> = {}) =>
  svc.record({ ip: '1.2.3.4', ua: UA, type: 'highlight_click', id: PRODUCT, row: 'featured', ...over });

describe('highlight_click', () => {
  it('counts once per session per row+product', async () => {
    const { svc, redis } = make();
    expect(await click(svc)).toBe(true);
    expect(await click(svc)).toBe(false);
    expect(redis.kv.get(highlightKey(pktDateOf(new Date()), STORE, 'featured'))).toBe('1');
  });
  it('a different row or a different visitor counts again', async () => {
    const { svc, redis } = make();
    await click(svc);
    expect(await click(svc, { row: 'bestSellers' })).toBe(true);
    expect(await click(svc, { ip: '9.9.9.9' })).toBe(true);
    expect(redis.kv.get(highlightKey(pktDateOf(new Date()), STORE, 'featured'))).toBe('2');
  });
  it('drops bots, bad rows and bad ids, and credits the product\'s own store only', async () => {
    const { svc, redis } = make();
    expect(await click(svc, { ua: 'curl/8' })).toBe(false);
    expect(await click(svc, { row: 'hacked' })).toBe(false);
    expect(await click(svc, { id: 'nope' })).toBe(false);
    expect(await click(svc)).toBe(true);
    expect([...redis.kv.keys()].some((k) => k.includes(OTHER_STORE))).toBe(false);
  });
  it('rolls up into the daily collection and empties Redis', async () => {
    const { svc, redis, clickRows } = make();
    await click(svc);
    await click(svc, { ip: '9.9.9.9' });
    await svc.rollup();
    expect(clickRows).toEqual([{ storeId: STORE, pktDate: pktDateOf(new Date()), row: 'featured', clicks: 2 }]);
    expect([...redis.kv.keys()].filter((k) => k.startsWith('av:h:'))).toHaveLength(0);
  });
  it('key helpers round-trip', () => {
    expect(parseHighlightKey(highlightKey('2026-11-12', STORE, 'newArrivals'))).toEqual({ pktDate: '2026-11-12', storeId: STORE, row: 'newArrivals' });
    expect(parseHighlightKey('av:h:2026-11-12:bad:featured')).toBeNull();
    expect(sanitizeHighlightRow('x')).toBeNull();
  });
});

describe('getPageInsights', () => {
  it('rejects a day count other than 7 or 30 and a foreign store', async () => {
    const storeModel: any = { findOne: async (q: any) => (q.sellerId === 's1' ? { _id: STORE } : null) };
    const svc = new VisitsService({ isConnected: true } as any, { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }), aggregate: async () => [] } as any, {} as any, {} as any, {} as any, storeModel,
      undefined, { aggregate: async () => [{ _id: 'featured', clicks: 3 }] } as any, { countDocuments: async () => 2 } as any);
    await expect(svc.getPageInsights('s1', STORE, '14')).rejects.toThrow(/7 or 30/);
    await expect(svc.getPageInsights('other', STORE, '7')).rejects.toThrow(/unauthorized/);
    const r: any = await svc.getPageInsights('s1', STORE, '7');
    expect(r.data).toMatchObject({ days: 7, visits: 0, newFollowers: 2, trackingSince: null, highlightClicks: { total: 3, byRow: { featured: 3, newArrivals: 0, bestSellers: 0 } } });
  });
});
