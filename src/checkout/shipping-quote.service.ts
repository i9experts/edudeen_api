/* eslint-disable prettier/prettier */
import { Injectable, Optional } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { buildCouriers, QUOTE_TIMEOUT_MS } from 'src/couriers/courier.adapters';
import type { CourierAdapter, QuoteResult } from 'src/couriers/courier.types';
import { applyMarkup, CodCollector, resolveCodCollector, CourierSettings, DELIVERY_COURIER_IDS, DeliveryCourierId, DeliveryMethod, weightBucket } from './courier-settings.util';
import { quoteRate, RateTable, RouteClass } from './shipping-rate.util';

export type QuoteSource = 'live' | 'slab' | 'zone' | 'self';

export interface ResolveQuoteInput {
  /** 'tcs' | 'leopards' | 'postex' | 'auto'. ('self' / null never reach this service.) */
  method: DeliveryMethod;
  originCity: string | null;
  destCity: string;
  route: RouteClass;
  billableKg: number;
  fragile?: boolean;
  /** Phase 1 slab table; only used when `enabled`. */
  rateTable: RateTable | null;
  settings: CourierSettings;
}

export interface ResolvedQuote {
  /** PKR. null = nothing quoted, the caller keeps the platform zone fee. */
  feePKR: number | null;
  source: QuoteSource;
  courier: DeliveryCourierId | null;
  service: string | null;
  etaDays: number | null;
}

const CACHE_TTL_OK = 3600;
const CACHE_TTL_FAIL = 120;

/**
 * Works out ONE store's delivery charge from the store's delivery method:
 * live courier quote (admin markup on top) -> Phase 1 slab table -> platform zone fee (caller).
 * A courier that has no credentials, or whose quote API is not implemented, reports "unavailable" and is skipped.
 */
@Injectable()
export class ShippingQuoteService {
  constructor(@Optional() private readonly redis?: RedisService) {}

  /** Overridable in tests. */
  buildAdapters: () => CourierAdapter[] = () => buildCouriers(process.env);

  private cacheKey(courier: string, origin: string | null, dest: string, kg: number) {
    const n = (s: string | null) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return `shipq:${courier}:${n(origin)}:${n(dest)}:${weightBucket(kg)}`;
  }

  private async cacheGet(key: string): Promise<QuoteResult | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as QuoteResult) : null;
    } catch { return null; }
  }

  private async cacheSet(key: string, value: QuoteResult) {
    if (!this.redis) return;
    try { await this.redis.set(key, JSON.stringify(value), value.ok ? CACHE_TTL_OK : CACHE_TTL_FAIL); } catch { /* Redis down: skip the cache */ }
  }

  /** One courier's raw quote (cached, 3 s timeout). Never throws. */
  async liveQuote(adapter: CourierAdapter, i: { originCity: string | null; destCity: string; billableKg: number }): Promise<QuoteResult> {
    if (!adapter.quote || !adapter.isConfigured()) return { ok: false, error: 'not configured' };
    const key = this.cacheKey(adapter.id, i.originCity, i.destCity, i.billableKg);
    const hit = await this.cacheGet(key);
    if (hit) return hit;
    let res: QuoteResult;
    let timer: NodeJS.Timeout | undefined;
    try {
      res = await Promise.race<QuoteResult>([
        adapter.quote({ originCity: i.originCity, destCity: i.destCity, weightKg: weightBucket(i.billableKg) }),
        new Promise<QuoteResult>((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), QUOTE_TIMEOUT_MS); }),
      ]);
    } catch (e: any) {
      res = { ok: false, error: String(e?.message ?? 'quote failed').slice(0, 120) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.ok && !(typeof res.feePKR === 'number' && Number.isFinite(res.feePKR) && res.feePKR >= 0)) res = { ok: false, error: 'bad quote' };
    await this.cacheSet(key, res);
    return res;
  }

  async resolve(i: ResolveQuoteInput): Promise<ResolvedQuote> {
    const specific = i.method !== 'auto' && i.method !== 'self' ? (i.method as DeliveryCourierId) : null;
    const candidates = (specific ? [specific] : DELIVERY_COURIER_IDS).filter((id) => i.settings.enabled[id]);

    if (i.settings.useLiveRates && candidates.length) {
      const adapters = this.buildAdapters();
      const results = await Promise.all(candidates.map(async (id) => {
        const adapter = adapters.find((a) => a.id === id);
        const q = adapter ? await this.liveQuote(adapter, { originCity: i.originCity, destCity: i.destCity, billableKg: i.billableKg }) : { ok: false } as QuoteResult;
        return { id, q };
      }));
      const ok = results
        .filter((r) => r.q.ok && typeof r.q.feePKR === 'number')
        .map((r) => ({ id: r.id, fee: applyMarkup(r.q.feePKR as number, i.settings), q: r.q }))
        .sort((a, b) => a.fee - b.fee);
      if (ok.length) {
        const best = ok[0];
        return { feePKR: best.fee, source: 'live', courier: best.id, service: best.q.service ?? null, etaDays: best.q.etaDays ?? null };
      }
    }

    // No live rate: the courier choice is still remembered for a specific method (booking is locked to it).
    const courier = specific;
    if (i.rateTable?.enabled) {
      const q = quoteRate(i.rateTable, { route: i.route, billableKg: i.billableKg, fragile: i.fragile });
      return { feePKR: q.feePKR, source: 'slab', courier, service: null, etaDays: null };
    }
    return { feePKR: null, source: 'zone', courier, service: null, etaDays: null };
  }

  /** storeId -> who collects that store's COD cash right now (see resolveCodCollector). */
  codCollectors(stores: Array<{ _id: any; deliveryMethod?: string | null; fulfillmentMode?: string | null }>, settings: CourierSettings): Map<string, CodCollector> {
    const usable = this.availableCouriers(settings);
    return new Map(stores.map((s) => [String(s._id), resolveCodCollector(s, usable)] as [string, CodCollector]));
  }

  /** Which courier ids are admin-enabled AND have credentials (used by the options endpoint). */
  availableCouriers(settings: CourierSettings): DeliveryCourierId[] {
    const adapters = this.buildAdapters();
    return DELIVERY_COURIER_IDS.filter((id) => settings.enabled[id] && adapters.find((a) => a.id === id)?.isConfigured());
  }
}
