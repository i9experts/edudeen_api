/* eslint-disable prettier/prettier */

/** In-memory sliding-window limiter (per process). Fine as a cost guard; the wallet is the real spend cap. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records a hit and returns true when allowed; false (and records nothing) when over the limit. */
  tryConsume(key: string): boolean {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(t);
    this.hits.set(key, fresh);
    if (this.hits.size > 5000) this.prune(t);
    return true;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) {
      if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    }
  }
}

/** Minimal slice of RedisService the limiter needs (so tests can fake it). */
export interface RateLimitRedis {
  readonly isConnected: boolean;
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * Shared (multi-instance) limiter: a fixed-window counter in Redis (INCR + EXPIRE) so the limit holds across
 * processes. When Redis is down or errors it falls back to the in-memory sliding window, so AI never breaks over it.
 */
export class RedisBackedLimiter {
  private readonly local: SlidingWindowLimiter;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly redis?: RateLimitRedis | null,
    now: () => number = () => Date.now(),
    private readonly prefix = 'ai:rl:',
  ) {
    this.local = new SlidingWindowLimiter(limit, windowMs, now);
  }

  async tryConsume(key: string): Promise<boolean> {
    if (this.redis?.isConnected) {
      try {
        const count = await this.redis.incrWithTtl(this.prefix + key, Math.max(1, Math.ceil(this.windowMs / 1000)));
        // 0 = the Redis wrapper skipped the call (it dropped); anything else is authoritative.
        if (count > 0) return count <= this.limit;
      } catch { /* fall through to the in-memory limiter */ }
    }
    return this.local.tryConsume(key);
  }
}
