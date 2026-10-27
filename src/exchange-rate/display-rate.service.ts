import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

// Display-only FX ("units per 1 USD" for ANY currency). Separate from ExchangeRateService on
// purpose: nothing here is stored in `exchange_rates`, has a sanity band or jump gate, or is ever
// used for charging, wallets, fees or refunds (those stay USD/PKR with their snapshots).

export interface DisplayRates {
  rates: Record<string, number>;
  asOf: string;
  /** true when the providers failed and a last-known-good set is being served. */
  stale: boolean;
}

interface Cached { rates: Record<string, number>; asOf: number; expiresAt: number }

const KEY_FRESH = 'fx:display:rates';
const KEY_LKG = 'fx:display:lkg';
const LKG_TTL_S = 30 * 24 * 3600;
const FALLBACK_TTL_MS = 60 * 60_000; // provider gave no "next update" time
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 6 * 60 * 60_000;

/** Keeps finite positive numbers only (no change-percentage rejection). */
export function cleanRates(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
    const k = code.toUpperCase();
    if (/^[A-Z]{3}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

@Injectable()
export class DisplayRateService {
  private readonly logger = new Logger(DisplayRateService.name);
  private mem: Cached | null = null;
  private lkg: Cached | null = null;
  private inflight: Promise<Cached | null> | null = null;

  constructor(@Optional() private readonly redis?: RedisService) {}

  /** Fresh rates when available, else last-known-good (stale), else null (caller shows native prices). */
  async getRates(now = Date.now()): Promise<DisplayRates | null> {
    if (this.mem && this.mem.expiresAt > now) return this.out(this.mem, false);
    const shared = await this.readRedis(KEY_FRESH);
    if (shared && shared.expiresAt > now) { this.mem = shared; return this.out(shared, false); }

    const fetched = await this.refresh(now);
    if (fetched) return this.out(fetched, false);

    const old = this.lkg ?? this.mem ?? (await this.readRedis(KEY_LKG));
    return old ? this.out(old, true) : null;
  }

  private out(c: Cached, stale: boolean): DisplayRates {
    return { rates: c.rates, asOf: new Date(c.asOf).toISOString(), stale };
  }

  private refresh(now: number): Promise<Cached | null> {
    if (!this.inflight) {
      this.inflight = this.fetchFromProviders(now)
        .then(async (c) => {
          if (c) {
            this.mem = c; this.lkg = c;
            await this.writeRedis(KEY_FRESH, c, Math.max(60, Math.ceil((c.expiresAt - now) / 1000)));
            await this.writeRedis(KEY_LKG, c, LKG_TTL_S);
          }
          return c;
        })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** Same chain as ExchangeRateService.fetchProviderRate, but whole-table and display-only. */
  private async fetchFromProviders(now: number): Promise<Cached | null> {
    const providers: { name: string; url: string; parse: (d: any) => { rates: unknown; next?: number } }[] = [
      { name: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD',
        parse: d => ({ rates: d?.result === 'success' ? d?.rates : undefined, next: Number(d?.time_next_update_unix) * 1000 }) },
      { name: 'currency-api (jsdelivr)', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
        parse: d => ({ rates: d?.usd }) },
      { name: 'frankfurter.dev', url: 'https://api.frankfurter.dev/v1/latest?base=USD', parse: d => ({ rates: d?.rates }) },
    ];
    for (const p of providers) {
      try {
        const res = await fetch(p.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const { rates: raw, next } = p.parse(await res.json());
        const rates = cleanRates(raw);
        if (Object.keys(rates).length < 5) continue; // not a real table
        rates.USD = 1;
        // Expire exactly when the provider says its next update is due (clamped), else 1 h.
        const ttl = Number.isFinite(next) && (next as number) > now
          ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, (next as number) - now))
          : FALLBACK_TTL_MS;
        return { rates, asOf: now, expiresAt: now + ttl };
      } catch (err: any) {
        this.logger.warn(`Display FX ${p.name} failed: ${err?.message}`);
      }
    }
    return null;
  }

  private async readRedis(key: string): Promise<Cached | null> {
    try {
      const raw = await this.redis?.get(key);
      if (!raw) return null;
      const c = JSON.parse(raw) as Cached;
      return c?.rates && typeof c.expiresAt === 'number' ? c : null;
    } catch { return null; }
  }

  private async writeRedis(key: string, c: Cached, ttlS: number) {
    try { await this.redis?.set(key, JSON.stringify(c), ttlS); } catch { /* cache only */ }
  }
}
