import { RedisBackedLimiter } from './rate-limiter';

function fakeRedis(connected = true) {
  const counts = new Map<string, number>();
  return {
    isConnected: connected,
    calls: 0,
    async incrWithTtl(key: string) { this.calls++; const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; },
  };
}

describe('RedisBackedLimiter', () => {
  it('uses Redis counters (shared across instances)', async () => {
    const redis = fakeRedis();
    const a = new RedisBackedLimiter(2, 60_000, redis);
    const b = new RedisBackedLimiter(2, 60_000, redis);
    expect(await a.tryConsume('k')).toBe(true);
    expect(await b.tryConsume('k')).toBe(true);
    expect(await a.tryConsume('k')).toBe(false);
    expect(redis.calls).toBe(3);
  });

  it('falls back to the in-memory window when Redis is down', async () => {
    let t = 0;
    const l = new RedisBackedLimiter(2, 1000, fakeRedis(false), () => t);
    expect(await l.tryConsume('k')).toBe(true);
    expect(await l.tryConsume('k')).toBe(true);
    expect(await l.tryConsume('k')).toBe(false);
    t = 1500;
    expect(await l.tryConsume('k')).toBe(true);
  });

  it('falls back when Redis throws or reports 0', async () => {
    const boom = { isConnected: true, incrWithTtl: async () => { throw new Error('down'); } };
    const l1 = new RedisBackedLimiter(1, 1000, boom);
    expect(await l1.tryConsume('k')).toBe(true);
    expect(await l1.tryConsume('k')).toBe(false);
    const zero = { isConnected: true, incrWithTtl: async () => 0 };
    const l2 = new RedisBackedLimiter(1, 1000, zero);
    expect(await l2.tryConsume('k')).toBe(true);
    expect(await l2.tryConsume('k')).toBe(false);
  });

  it('works with no Redis at all', async () => {
    const l = new RedisBackedLimiter(1, 1000, null);
    expect(await l.tryConsume('x')).toBe(true);
    expect(await l.tryConsume('x')).toBe(false);
  });
});
