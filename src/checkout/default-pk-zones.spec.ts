import { DEFAULT_PK_ZONES, missingDefaultZones } from './default-pk-zones';

describe('default PK zones', () => {
  it('has a country-wide fallback and unique keys', () => {
    expect(DEFAULT_PK_ZONES.some((z) => !z.province && !z.city)).toBe(true);
    const keys = DEFAULT_PK_ZONES.map((z) => `${z.province}|${z.city}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('adds everything to an empty list', () => {
    expect(missingDefaultZones([])).toHaveLength(DEFAULT_PK_ZONES.length);
  });
  it('is idempotent and never duplicates existing zones (case-insensitive)', () => {
    const existing = [{ country: 'pakistan', province: 'sindh', city: 'KARACHI' }, { country: 'Pakistan', province: null, city: null }];
    const missing = missingDefaultZones(existing);
    expect(missing).toHaveLength(DEFAULT_PK_ZONES.length - 2);
    expect(missing.find((z) => z.city === 'Karachi')).toBeUndefined();
    const all = DEFAULT_PK_ZONES.map((z) => ({ country: 'Pakistan', province: z.province, city: z.city }));
    expect(missingDefaultZones(all)).toEqual([]);
  });
});
