import { filterValidRailProducts, isValidRailProduct } from './home-rail.util';

const prod = (v: any) => ({ variants: [{ isDefault: true, ...v }] });

describe('isValidRailProduct', () => {
  it('accepts a normal priced item and a real sale', () => {
    expect(isValidRailProduct(prod({ price: 500 }))).toBe(true);
    expect(isValidRailProduct(prod({ price: 500, compareAtPrice: 800 }))).toBe(true);
    expect(isValidRailProduct(prod({ price: 500, campaignPrice: 400 }))).toBe(true);
  });
  it('keeps a genuine free item (price 0, nothing struck through)', () => {
    expect(isValidRailProduct(prod({ price: 0 }))).toBe(true);
    expect(isValidRailProduct(prod({ price: 0, compareAtPrice: null }))).toBe(true);
    expect(isValidRailProduct(prod({ price: 0, compareAtPrice: 0 }))).toBe(true);
  });
  it('rejects Rs 0 with a strike price (-100%)', () => {
    expect(isValidRailProduct(prod({ price: 0, compareAtPrice: 500 }))).toBe(false);
  });
  it('rejects a platform sale price of 0 (-100%)', () => {
    expect(isValidRailProduct(prod({ price: 500, campaignPrice: 0 }))).toBe(false);
  });
  it('rejects negative prices and products with no variant', () => {
    expect(isValidRailProduct(prod({ price: -1 }))).toBe(false);
    expect(isValidRailProduct({ variants: [] })).toBe(false);
    expect(isValidRailProduct({})).toBe(false);
  });
  it('filterValidRailProducts keeps order', () => {
    const a = prod({ price: 10 }); const b = prod({ price: 0, compareAtPrice: 9 }); const c = prod({ price: 0 });
    expect(filterValidRailProducts([a, b, c])).toEqual([a, c]);
  });
});
