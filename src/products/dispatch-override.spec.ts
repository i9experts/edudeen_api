import { cleanParcelMeta } from './product-input.util';

describe('dispatchDaysOverride (physical products)', () => {
  it('accepts 1..7 and null/empty (= use the store value)', () => {
    expect(cleanParcelMeta({ dispatchDaysOverride: 4 }, false).dispatchDaysOverride).toBe(4);
    expect(cleanParcelMeta({ dispatchDaysOverride: null }, false).dispatchDaysOverride).toBeNull();
    expect(cleanParcelMeta({ dispatchDaysOverride: '' }, false).dispatchDaysOverride).toBeNull();
    expect('dispatchDaysOverride' in cleanParcelMeta({}, true)).toBe(false);
  });
  it('rejects 0, 8, decimals and text with 400', () => {
    for (const bad of [0, 8, 2.5, -1, 'x', '3']) expect(() => cleanParcelMeta({ dispatchDaysOverride: bad }, false)).toThrow(/1 to 7/);
  });
});
