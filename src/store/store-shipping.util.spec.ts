import { isStoreShippingConfigured } from './store-shipping.util';

describe('isStoreShippingConfigured (COD gate)', () => {
  it('fresh store: no shipping, so COD is hidden', () => {
    expect(isStoreShippingConfigured({})).toBe(false);
    expect(isStoreShippingConfigured(null)).toBe(false);
    expect(isStoreShippingConfigured({ deliverySettings: { enabled: false }, shipFrom: { city: '  ' } })).toBe(false);
  });
  it('any of delivery method, own delivery or ship-from city counts', () => {
    expect(isStoreShippingConfigured({ deliveryMethod: 'courier' })).toBe(true);
    expect(isStoreShippingConfigured({ deliverySettings: { enabled: true } })).toBe(true);
    expect(isStoreShippingConfigured({ shipFrom: { city: 'Lahore' } })).toBe(true);
  });
});
