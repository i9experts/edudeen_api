import { parcelTotals } from './parcel-totals.util';

const info = {
  products: new Map<string, any>([
    ['p1', { parcelType: 'standard', packageCm: null }],
    ['p2', { parcelType: 'fragile', packageCm: { l: 50, w: 40, h: 30 } }],
  ]),
  variants: new Map<string, any>([
    ['v1', { shippingWeight: '0.4 kg' }],
    ['v2', { shippingWeight: '500 g' }],
    ['v3', { shippingWeight: null }],
  ]),
};

describe('parcelTotals', () => {
  it('sums weight x quantity', () => {
    expect(parcelTotals([{ productId: 'p1', variantId: 'v1', quantity: 3 }], info, 5000)).toEqual({ billableKg: 1.2, fragile: false });
  });

  it('uses volumetric weight when the packed size is bigger than the real weight, and flags fragile', () => {
    const r = parcelTotals([{ productId: 'p2', variantId: 'v2', quantity: 1 }], info, 5000);
    expect(r.billableKg).toBe(12); // 50*40*30/5000
    expect(r.fragile).toBe(true);
  });

  it('counts a line with no weight as 0.5 kg (never free)', () => {
    expect(parcelTotals([{ productId: 'p1', variantId: 'v3', quantity: 2 }], info, 5000).billableKg).toBe(1);
  });
});
