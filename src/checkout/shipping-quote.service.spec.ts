/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { ShippingQuoteService } from './shipping-quote.service';
import { DEFAULT_COURIER_SETTINGS, applyMarkup, sanitizeCourierSettings, weightBucket } from './courier-settings.util';
import { DEFAULT_RATE_TABLE, sanitizeRateTable } from './shipping-rate.util';

const slabTable = () => sanitizeRateTable({
  enabled: true,
  routes: {
    sameCity: { slabs: [{ upToKg: 1, feePKR: 150 }] },
    sameProvince: { slabs: [{ upToKg: 1, feePKR: 200 }] },
    national: { slabs: [{ upToKg: 1, feePKR: 300 }] },
  },
});

const adapter = (id: string, fee: number | null, configured = true) => {
  const quote = jest.fn(async () => (fee == null ? { ok: false, error: 'quote not available yet' } : { ok: true, feePKR: fee, service: `${id}-std`, etaDays: 3 }));
  return { id, label: id, isConfigured: () => configured, quote } as any;
};

const base = {
  originCity: 'Lahore', destCity: 'Karachi', route: 'national' as const, billableKg: 0.8, rateTable: null as any,
};
const settings = (over: any = {}) => sanitizeCourierSettings({ enabled: { tcs: true, leopards: true, postex: true }, useLiveRates: true, ...over });

function make(adapters: any[], redis?: any) {
  const svc = new ShippingQuoteService(redis);
  svc.buildAdapters = () => adapters;
  return svc;
}

describe('ShippingQuoteService.resolve', () => {
  it('a specific courier with a live quote charges that quote', async () => {
    const tcs = adapter('tcs', 250);
    const r = await make([tcs, adapter('leopards', 100)]).resolve({ ...base, method: 'tcs', settings: settings() });
    expect(r).toEqual({ feePKR: 250, source: 'live', courier: 'tcs', service: 'tcs-std', etaDays: 3 });
  });

  it('live fails -> falls back to the slab table and remembers the chosen courier', async () => {
    const r = await make([adapter('tcs', null)]).resolve({ ...base, method: 'tcs', rateTable: slabTable(), settings: settings() });
    expect(r).toMatchObject({ feePKR: 300, source: 'slab', courier: 'tcs' });
  });

  it('live fails and slab table off -> zone fee (feePKR null)', async () => {
    const r = await make([adapter('tcs', null)]).resolve({ ...base, method: 'tcs', rateTable: DEFAULT_RATE_TABLE, settings: settings() });
    expect(r).toMatchObject({ feePKR: null, source: 'zone', courier: 'tcs' });
  });

  it('live rates switched off never calls a courier', async () => {
    const tcs = adapter('tcs', 250);
    const r = await make([tcs]).resolve({ ...base, method: 'tcs', rateTable: slabTable(), settings: settings({ useLiveRates: false }) });
    expect(tcs.quote).not.toHaveBeenCalled();
    expect(r.source).toBe('slab');
  });

  it('a courier the admin has not enabled is skipped', async () => {
    const tcs = adapter('tcs', 250);
    const r = await make([tcs]).resolve({ ...base, method: 'tcs', rateTable: slabTable(), settings: settings({ enabled: { tcs: false } }) });
    expect(tcs.quote).not.toHaveBeenCalled();
    expect(r.source).toBe('slab');
  });

  it("'auto' picks the cheapest available quote and ignores the ones that failed", async () => {
    const r = await make([adapter('tcs', 400), adapter('leopards', 220), adapter('postex', null)]).resolve({ ...base, method: 'auto', settings: settings() });
    expect(r).toMatchObject({ feePKR: 220, courier: 'leopards', source: 'live' });
  });

  it("'auto' with no live quote falls back to the slab and sets no courier", async () => {
    const r = await make([adapter('tcs', null), adapter('leopards', null, false)]).resolve({ ...base, method: 'auto', rateTable: slabTable(), settings: settings() });
    expect(r).toMatchObject({ feePKR: 300, source: 'slab', courier: null });
  });

  it('markup (% + handling fee) applies to live quotes only', async () => {
    const s = settings({ markupPct: 10, handlingFeePKR: 20 });
    const live = await make([adapter('tcs', 200)]).resolve({ ...base, method: 'tcs', settings: s });
    expect(live.feePKR).toBe(240); // 200 * 1.1 + 20
    const slab = await make([adapter('tcs', null)]).resolve({ ...base, method: 'tcs', rateTable: slabTable(), settings: s });
    expect(slab.feePKR).toBe(300); // untouched
    expect(applyMarkup(100, { markupPct: 0, handlingFeePKR: 0 })).toBe(100);
  });

  it('a timed-out courier counts as unavailable', async () => {
    jest.useFakeTimers();
    try {
      const slow = { id: 'tcs', label: 'tcs', isConfigured: () => true, quote: () => new Promise(() => undefined) } as any;
      const p = make([slow]).resolve({ ...base, method: 'tcs', rateTable: slabTable(), settings: settings() });
      await jest.advanceTimersByTimeAsync(3100);
      expect((await p).source).toBe('slab');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a nonsense live quote (negative / not a number) is rejected', async () => {
    const bad = { id: 'tcs', label: 'tcs', isConfigured: () => true, quote: async () => ({ ok: true, feePKR: -5 }) } as any;
    const r = await make([bad]).resolve({ ...base, method: 'tcs', rateTable: slabTable(), settings: settings() });
    expect(r.source).toBe('slab');
  });
});

describe('quote cache', () => {
  const memRedis = () => {
    const m = new Map<string, string>();
    return { get: jest.fn(async (k: string) => m.get(k) ?? null), set: jest.fn(async (k: string, v: string) => { m.set(k, v); }), m } as any;
  };

  it('second identical quote comes from cache (same 0.5 kg bucket), different bucket misses', async () => {
    const redis = memRedis();
    const tcs = adapter('tcs', 250);
    const svc = make([tcs], redis);
    await svc.resolve({ ...base, method: 'tcs', billableKg: 0.6, settings: settings() });
    await svc.resolve({ ...base, method: 'tcs', billableKg: 0.9, settings: settings() }); // both in the 1.0 bucket
    expect(tcs.quote).toHaveBeenCalledTimes(1);
    await svc.resolve({ ...base, method: 'tcs', billableKg: 1.2, settings: settings() }); // 1.5 bucket
    expect(tcs.quote).toHaveBeenCalledTimes(2);
    expect(redis.set.mock.calls[0][2]).toBe(3600);
  });

  it('cached raw quotes get the CURRENT markup (admin change applies immediately)', async () => {
    const redis = memRedis();
    const svc = make([adapter('tcs', 200)], redis);
    expect((await svc.resolve({ ...base, method: 'tcs', settings: settings({ markupPct: 0 }) })).feePKR).toBe(200);
    expect((await svc.resolve({ ...base, method: 'tcs', settings: settings({ markupPct: 50 }) })).feePKR).toBe(300);
  });

  it('Redis down: quotes still work without the cache', async () => {
    const redis = { get: jest.fn().mockRejectedValue(new Error('down')), set: jest.fn().mockRejectedValue(new Error('down')) } as any;
    const r = await make([adapter('tcs', 250)], redis).resolve({ ...base, method: 'tcs', settings: settings() });
    expect(r.source).toBe('live');
  });
});

describe('courier settings helpers', () => {
  it('sanitises and validates', () => {
    expect(sanitizeCourierSettings({})).toEqual(DEFAULT_COURIER_SETTINGS);
    expect(() => sanitizeCourierSettings({ markupPct: 150 })).toThrow(/Markup/);
    expect(() => sanitizeCourierSettings({ handlingFeePKR: -1 })).toThrow(/Handling/);
    expect(sanitizeCourierSettings({ enabled: { tcs: true, foo: true }, markupPct: '12.5' })).toMatchObject({ enabled: { tcs: true, leopards: false, postex: false }, markupPct: 12.5 });
  });
  it('weight buckets', () => {
    expect([weightBucket(0), weightBucket(0.5), weightBucket(0.51), weightBucket(1.2)]).toEqual([0.5, 0.5, 1, 1.5]);
  });
  it('availableCouriers needs enabled AND configured', () => {
    const svc = make([adapter('tcs', 1, true), adapter('leopards', 1, false), adapter('postex', 1, true)]);
    expect(svc.availableCouriers(settings({ enabled: { tcs: true, leopards: true, postex: false } }))).toEqual(['tcs']);
  });
});
