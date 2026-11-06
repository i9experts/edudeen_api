/* eslint-disable prettier/prettier */
import { VisitsService } from './visits.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  conversionRate, counterKey, isBotUserAgent, parseCounterKey, parseTermKey, pktDateOf, sanitizeSource, sanitizeTerm, sessionHash, termKey,
} from './visit-tracking.util';

const STORE = 'a'.repeat(24);
const PRODUCT = 'b'.repeat(24);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** Tiny in-memory stand-in for RedisService (only the methods the service uses). */
class FakeRedis {
  isConnected = true;
  kv = new Map<string, string>();
  async setNx(k: string) { if (!this.isConnected) return null; if (this.kv.has(k)) return false; this.kv.set(k, '1'); return true; }
  async incrBy(k: string, n: number) { if (!this.isConnected) return; this.kv.set(k, String(Number(this.kv.get(k) ?? 0) + n)); }
  async scanKeys(p: string) { const pre = p.replace('*', ''); return [...this.kv.keys()].filter((k) => k.startsWith(pre)); }
  async getDel(k: string) { const v = this.kv.get(k) ?? null; this.kv.delete(k); return v; }
  async withLock(_k: string, _t: number, fn: () => Promise<void>) { await fn(); return 'ran' as const; }
}

function makeService(opts: { failWrite?: boolean; knownStores?: string[] } = {}) {
  const redis = new FakeRedis();
  const rows: any[] = [];
  const termRows: any[] = [];
  const bulk = (target: any[]) => async (ops: any[]) => {
    if (opts.failWrite) throw new Error('mongo down');
    for (const { updateOne: u } of ops) {
      const hit = target.find((r) => Object.keys(u.filter).every((k) => r[k] === u.filter[k]));
      if (hit) hit.visits += u.update.$inc.visits; else target.push({ ...u.filter, visits: u.update.$inc.visits });
    }
  };
  const visitModel: any = { bulkWrite: bulk(rows) };
  const termModel: any = { bulkWrite: bulk(termRows) };
  const productModel: any = { findOne: () => ({ select: () => ({ lean: async () => ({ storeId: STORE }) }) }) };
  const known = opts.knownStores ?? [STORE];
  const storeModel: any = { find: (q: any) => ({ select: () => ({ lean: async () => known.filter((s) => q._id.$in.includes(s)).map((s) => ({ _id: s })) }) }) };
  const svc = new VisitsService(redis as any, visitModel, termModel, {} as any, productModel, storeModel);
  return { svc, redis, rows, termRows };
}

describe('visit-tracking util', () => {
  it('flags bots and empty user agents, accepts browsers', () => {
    expect(isBotUserAgent(UA)).toBe(false);
    expect(isBotUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUserAgent('curl/8.0.1')).toBe(true);
    expect(isBotUserAgent('HeadlessChrome/120')).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
  });
  it('session hash rotates every PKT day and differs per visitor', () => {
    const a = sessionHash('1.1.1.1', UA, '2026-11-06', 's');
    expect(a).toBe(sessionHash('1.1.1.1', UA, '2026-11-06', 's'));
    expect(a).not.toBe(sessionHash('1.1.1.1', UA, '2026-11-07', 's'));
    expect(a).not.toBe(sessionHash('1.1.1.2', UA, '2026-11-06', 's'));
    expect(a).not.toBe(sessionHash('1.1.1.1', UA, '2026-11-06', 'other-secret'));
    expect(a).not.toContain('1.1.1.1');
  });
  it('PKT date flips at 19:00 UTC', () => {
    expect(pktDateOf(new Date('2026-11-06T18:59:00Z'))).toBe('2026-11-06');
    expect(pktDateOf(new Date('2026-11-06T19:00:00Z'))).toBe('2026-11-07');
  });
  it('sanitises source and search terms', () => {
    expect(sanitizeSource('social')).toBe('social');
    expect(sanitizeSource('hacker')).toBe('direct');
    expect(sanitizeTerm('  Class 5 MATHS!! ')).toBe('class 5 maths');
    expect(sanitizeTerm('a')).toBeNull();
    expect(sanitizeTerm('call 03001234567')).toBeNull();
    expect(sanitizeTerm('me@mail.com')).toBeNull();
    expect(sanitizeTerm('اردو قاعدہ')).toBe('اردو قاعدہ');
  });
  it('counter and term keys round-trip', () => {
    expect(parseCounterKey(counterKey('2026-11-06', STORE, null, 'social'))).toEqual({ pktDate: '2026-11-06', storeId: STORE, productId: null, source: 'social' });
    expect(parseCounterKey(counterKey('2026-11-06', STORE, PRODUCT, 'direct'))?.productId).toBe(PRODUCT);
    expect(parseCounterKey('av:c:bad')).toBeNull();
    expect(parseTermKey(termKey('2026-11-06', STORE, 'urdu qaida'))?.term).toBe('urdu qaida');
  });
  it('conversion = paid orders / visits, null without visits, capped at 100', () => {
    expect(conversionRate(5, 200)).toBe(2.5);
    expect(conversionRate(1, 3)).toBe(33.33);
    expect(conversionRate(0, 50)).toBe(0);
    expect(conversionRate(4, 0)).toBeNull();
    expect(conversionRate(9, 3)).toBe(100);
  });
});

describe('VisitsService.record', () => {
  const view = (svc: VisitsService, over: any = {}) => svc.record({ ip: '2.2.2.2', ua: UA, type: 'store', id: STORE, source: 'direct', ...over });

  it('counts one visit and dedupes the same visitor within 30 minutes', async () => {
    const { svc, redis } = makeService();
    expect(await view(svc)).toBe(true);
    expect(await view(svc)).toBe(false);
    expect(redis.kv.get(counterKey(pktDateOf(new Date()), STORE, null, 'direct'))).toBe('1');
    expect(await view(svc, { ip: '3.3.3.3' })).toBe(true); // another visitor
    expect(redis.kv.get(counterKey(pktDateOf(new Date()), STORE, null, 'direct'))).toBe('2');
  });

  it('drops bots, bad ids and bad types', async () => {
    const { svc, redis } = makeService();
    expect(await view(svc, { ua: 'Googlebot/2.1' })).toBe(false);
    expect(await view(svc, { id: 'nope' })).toBe(false);
    expect(await view(svc, { type: 'order' })).toBe(false);
    expect(redis.kv.size).toBe(0);
  });

  it('Redis down = silently dropped, never throws', async () => {
    const { svc, redis } = makeService();
    redis.isConnected = false;
    await expect(view(svc)).resolves.toBe(false);
  });

  it('product view counts the product and (once) the store; unknown source becomes direct; term only for Edudeen search', async () => {
    const { svc, redis } = makeService();
    const day = pktDateOf(new Date());
    expect(await view(svc, { type: 'product', id: PRODUCT, source: 'edudeen_search', term: 'Urdu Qaida' })).toBe(true);
    expect(redis.kv.get(counterKey(day, STORE, PRODUCT, 'edudeen_search'))).toBe('1');
    expect(redis.kv.get(counterKey(day, STORE, null, 'edudeen_search'))).toBe('1');
    expect(redis.kv.get(termKey(day, STORE, 'urdu qaida'))).toBe('1');
    // same visitor opens the store page right after: no second store visit
    expect(await view(svc, { type: 'store', id: STORE, source: 'edudeen_search' })).toBe(false);
    expect(redis.kv.get(counterKey(day, STORE, null, 'edudeen_search'))).toBe('1');
    // term from a non-search source is ignored
    await view(svc, { ip: '9.9.9.9', source: 'social', term: 'x y z' });
    expect([...redis.kv.keys()].some((k) => k.startsWith('av:t:') && k.includes(Buffer.from('x y z').toString('base64url')))).toBe(false);
  });
});

describe('VisitsService.rollup', () => {
  it('moves counters into the daily rows with $inc and empties Redis', async () => {
    const { svc, redis, rows, termRows } = makeService();
    const day = pktDateOf(new Date());
    await svc.record({ ip: '1.1.1.1', ua: UA, type: 'store', id: STORE, source: 'edudeen_search', term: 'maths' });
    await svc.record({ ip: '1.1.1.2', ua: UA, type: 'store', id: STORE, source: 'edudeen_search', term: 'maths' });
    await svc.record({ ip: '1.1.1.3', ua: UA, type: 'store', id: STORE, source: 'social' });
    const out = await svc.rollup();
    expect(out.visitRows).toBe(2);
    expect(rows.find((r) => r.source === 'edudeen_search')).toMatchObject({ storeId: STORE, productId: '', pktDate: day, visits: 2 });
    expect(rows.find((r) => r.source === 'social')?.visits).toBe(1);
    expect(termRows[0]).toMatchObject({ term: 'maths', visits: 2 });
    expect([...redis.kv.keys()].filter((k) => k.startsWith('av:c:') || k.startsWith('av:t:'))).toHaveLength(0);
    // a second run adds on top of the same row (upsert $inc), no duplicates
    await svc.record({ ip: '1.1.1.9', ua: UA, type: 'store', id: STORE, source: 'social' });
    await svc.rollup();
    expect(rows.filter((r) => r.source === 'social')).toHaveLength(1);
    expect(rows.find((r) => r.source === 'social')?.visits).toBe(2);
  });

  it('puts the counts back when Mongo fails (nothing lost)', async () => {
    const { svc, redis } = makeService({ failWrite: true });
    await svc.record({ ip: '1.1.1.1', ua: UA, type: 'store', id: STORE, source: 'direct' });
    await expect(svc.rollup()).rejects.toThrow('mongo down');
    expect(redis.kv.get(counterKey(pktDateOf(new Date()), STORE, null, 'direct'))).toBe('1');
  });

  it('drops counters of stores that do not exist', async () => {
    const { svc, rows } = makeService({ knownStores: [] });
    await svc.record({ ip: '1.1.1.1', ua: UA, type: 'store', id: STORE, source: 'direct' });
    const out = await svc.rollup();
    expect(out.visitRows).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describe('realtime', () => {
  it('page-view beacons never publish a topic', () => {
    const rt = new RealtimeService();
    expect(rt.topicsForPath('/api/analytics/view')).toEqual([]);
    expect(rt.topicsForPath('/API/analytics/view/')).toEqual([]);
    expect(rt.topicsForPath('/api/seller/analytics/anything')).not.toEqual([]); // other writes unchanged
  });
});
