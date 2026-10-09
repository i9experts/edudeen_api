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
