import { billableKg, cleanDimensions, DEFAULT_RATE_TABLE, quoteRate, routeClass, sanitizeRateTable } from './shipping-rate.util';

const table = sanitizeRateTable({
  enabled: true,
  routes: {
    sameCity: { slabs: [{ upToKg: 0.5, feePKR: 150 }, { upToKg: 1, feePKR: 200 }], extraPerKgPKR: 50 },
    sameProvince: { slabs: [{ upToKg: 0.5, feePKR: 200 }, { upToKg: 1, feePKR: 260 }], extraPerKgPKR: 70 },
    national: { slabs: [{ upToKg: 0.5, feePKR: 250 }, { upToKg: 1, feePKR: 330 }], extraPerKgPKR: 100 },
  },
  fragileSurchargePKR: 100,
  fuelSurchargePct: 10,
  taxPct: 0,
});

describe('shipping-rate.util', () => {
  it('picks the slab that fits the billable weight (edges included)', () => {
    expect(quoteRate(table, { route: 'national', billableKg: 0.5 }).feePKR).toBe(275); // 250 + 10%
    expect(quoteRate(table, { route: 'national', billableKg: 0.51 }).feePKR).toBe(363); // 330 + 10%
    expect(quoteRate(table, { route: 'sameCity', billableKg: 0.1 }).feePKR).toBe(165);
  });

  it('adds the extra per started kg above the last slab', () => {
    // 2.2 kg -> 1 kg slab (200) + ceil(1.2) = 2 extra kg * 50 = 300, +10% = 330
    expect(quoteRate(table, { route: 'sameCity', billableKg: 2.2 }).feePKR).toBe(330);
    // exactly 2 kg -> 1 extra kg
    expect(quoteRate(table, { route: 'sameCity', billableKg: 2 }).feePKR).toBe(275);
  });

  it('adds the fragile surcharge before fuel and tax', () => {
    expect(quoteRate(table, { route: 'national', billableKg: 0.4, fragile: true }).feePKR).toBe(385); // (250+100) * 1.1
  });

  it('bills the larger of real and volumetric weight', () => {
    expect(billableKg(0.5, { l: 50, w: 40, h: 30 })).toBe(12); // 60000 / 5000
    expect(billableKg(3, { l: 10, w: 10, h: 10 })).toBe(3);
    expect(billableKg(0.5, null)).toBe(0.5);
  });

  it('classifies the route (unknown origin = national)', () => {
    expect(routeClass({ city: 'Lahore', province: 'Punjab' }, { city: ' lahore ', province: 'Punjab' })).toBe('sameCity');
    expect(routeClass({ city: 'Lahore', province: 'Punjab' }, { city: 'Multan', province: 'Punjab' })).toBe('sameProvince');
    expect(routeClass({ city: 'Lahore', province: 'Punjab' }, { city: 'Karachi', province: 'Sindh' })).toBe('national');
    expect(routeClass({}, { city: 'Karachi', province: 'Sindh' })).toBe('national');
  });

  it('rejects slabs where a heavier slab is cheaper or limits repeat', () => {
    expect(() => sanitizeRateTable({ routes: { sameCity: { slabs: [{ upToKg: 1, feePKR: 200 }, { upToKg: 2, feePKR: 100 }] } } })).toThrow(/can't cost less/);
    expect(() => sanitizeRateTable({ routes: { sameCity: { slabs: [{ upToKg: 1, feePKR: 100 }, { upToKg: 1, feePKR: 120 }] } } })).toThrow(/same weight/);
  });

  it('defaults to disabled so nothing changes until the admin turns it on', () => {
    expect(DEFAULT_RATE_TABLE.enabled).toBe(false);
    expect(sanitizeRateTable({}).enabled).toBe(false);
  });

  it('cleans dimensions: none -> null, partial/invalid -> error', () => {
    expect(cleanDimensions(undefined)).toBeNull();
    expect(cleanDimensions({})).toBeNull();
    expect(cleanDimensions({ l: 10, w: 5, h: 2 })).toEqual({ l: 10, w: 5, h: 2 });
    expect(() => cleanDimensions({ l: 10, w: 5 })).toThrow();
    expect(() => cleanDimensions({ l: 300, w: 5, h: 2 })).toThrow(/200 cm/);
  });
});
