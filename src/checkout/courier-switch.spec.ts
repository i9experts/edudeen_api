import { courierDeliveryEnabled, parseDeliveryMethod, resolveCodCollector } from './courier-settings.util';

describe('courier delivery master switch (COURIER_DELIVERY_ENABLED)', () => {
  const OLD = process.env.COURIER_DELIVERY_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.COURIER_DELIVERY_ENABLED;
    else process.env.COURIER_DELIVERY_ENABLED = OLD;
  });

  it('is OFF by default', () => {
    delete process.env.COURIER_DELIVERY_ENABLED;
    expect(courierDeliveryEnabled()).toBe(false);
  });

  it('while off: only "self" survives; a courier method saved earlier is ignored', () => {
    delete process.env.COURIER_DELIVERY_ENABLED;
    expect(parseDeliveryMethod('self')).toBe('self');
    for (const m of ['tcs', 'leopards', 'postex', 'auto']) expect(parseDeliveryMethod(m)).toBeNull();
  });

  it('while off: Edudeen never collects COD cash for a courier store (even if usable)', () => {
    delete process.env.COURIER_DELIVERY_ENABLED;
    expect(resolveCodCollector({ deliveryMethod: 'tcs' }, ['tcs'])).toBe('seller');
    expect(resolveCodCollector({ deliveryMethod: 'auto' }, ['tcs', 'postex'])).toBe('seller');
  });

  it('while on: courier methods work again', () => {
    process.env.COURIER_DELIVERY_ENABLED = 'true';
    expect(parseDeliveryMethod('tcs')).toBe('tcs');
    expect(resolveCodCollector({ deliveryMethod: 'tcs' }, ['tcs'])).toBe('platform');
  });
});
