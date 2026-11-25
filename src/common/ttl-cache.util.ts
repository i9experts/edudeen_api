/**
 * Tiny in-process cache for PUBLIC, rarely-changing, identical-for-everyone reads (category tree, testimonials).
 * Concurrent misses share one load. Per API instance: admin edits clear it on that instance at once, other instances
 * catch up within the TTL. Never use it for anything personalised or money-related.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { exp: number; value: T }>();
  private readonly loading = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number, private readonly maxKeys = 50) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const running = this.loading.get(key);
    if (running) return running;
    const p = load()
      .then((value) => {
        if (this.entries.size >= this.maxKeys) this.entries.clear();
        this.entries.set(key, { exp: Date.now() + this.ttlMs, value });
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  clear() {
    this.entries.clear();
  }
}
