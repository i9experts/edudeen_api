import { productController } from './products.controller';

// Guest browse/bestsellers lists are cached in Redis (60 s) and the cache is dropped when a catalog topic fires.
// Signed-in buyers and search terms are never cached (member prices / personal badges / typo fixes).
describe('productController browse cache', () => {
  const makeRedis = () => {
    const store = new Map<string, string>();
    return {
      store,
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
      incrBy: jest.fn(async (k: string, by: number) => { store.set(k, String(Number(store.get(k) ?? 0) + by)); }),
    };
  };
  const make = (redis: any, realtime?: any) =>
    new productController({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, redis, realtime);

  it('serves the second guest call from Redis (loader runs once)', async () => {
    const redis = makeRedis(); const c: any = make(redis);
    const load = jest.fn(async () => ({ data: { products: [1, 2] } }));
    const a = await c.cachedBrowse(true, { id: 'x', page: 1 }, load);
    const b = await c.cachedBrowse(true, { id: 'x', page: 1 }, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('different filters never share an entry', async () => {
    const redis = makeRedis(); const c: any = make(redis);
    const load = jest.fn(async () => ({ n: Math.random() }));
    await c.cachedBrowse(true, { id: 'x', classQuery: 'class-1' }, load);
    await c.cachedBrowse(true, { id: 'x', classQuery: 'class-2' }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('signed-in / search requests skip the cache entirely', async () => {
    const redis = makeRedis(); const c: any = make(redis);
    const load = jest.fn(async () => ({ ok: 1 }));
    await c.cachedBrowse(false, { id: 'x' }, load);
    await c.cachedBrowse(false, { id: 'x' }, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('a catalog topic bumps the version so the next call reloads', async () => {
    const redis = makeRedis();
    let fire: (t: string[]) => void = () => undefined;
    const realtime = { onTopics: (fn: (t: string[]) => void) => { fire = fn; return () => undefined; } };
    const c: any = make(redis, realtime); c.onModuleInit();
    const load = jest.fn(async () => ({ ok: Math.random() }));
    await c.cachedBrowse(true, { id: 'x' }, load);
    fire(['orders']); // unrelated topic: still cached
    await c.cachedBrowse(true, { id: 'x' }, load);
    expect(load).toHaveBeenCalledTimes(1);
    fire(['products']);
    await new Promise((r) => setImmediate(r));
    await c.cachedBrowse(true, { id: 'x' }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a Redis failure falls through to the loader', async () => {
    const redis: any = { get: jest.fn(async () => { throw new Error('down'); }), set: jest.fn(), incrBy: jest.fn() };
    const c: any = make(redis);
    const load = jest.fn(async () => ({ ok: 1 }));
    await expect(c.cachedBrowse(true, { id: 'x' }, load)).resolves.toEqual({ ok: 1 });
  });
});
