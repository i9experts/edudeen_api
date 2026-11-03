process.env.COURIER_DELIVERY_ENABLED = 'true'; // these specs cover the courier-on paths (the switch is off by default)
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { DEFAULT_COURIER_SETTINGS, resolveCodCollector } from './courier-settings.util';
import { ShippingQuoteService } from './shipping-quote.service';
import { cashMode, isSellerCollectedCod } from '../finance/finance.service';

const settings = (enabled: Partial<Record<'tcs' | 'leopards' | 'postex', boolean>>) => ({ ...DEFAULT_COURIER_SETTINGS, enabled: { tcs: false, leopards: false, postex: false, ...enabled } });

describe('resolveCodCollector (who collects the COD cash)', () => {
  it('a usable courier chosen by the store -> platform', () => {
    expect(resolveCodCollector({ deliveryMethod: 'tcs' }, ['tcs'])).toBe('platform');
    expect(resolveCodCollector({ deliveryMethod: 'leopards' }, ['tcs', 'leopards'])).toBe('platform');
  });
  it("'auto' is platform when at least one courier is usable", () => {
    expect(resolveCodCollector({ deliveryMethod: 'auto' }, ['postex'])).toBe('platform');
    expect(resolveCodCollector({ deliveryMethod: 'auto' }, [])).toBe('seller');
  });
  it('the chosen courier is not enabled / not configured -> seller', () => {
    expect(resolveCodCollector({ deliveryMethod: 'tcs' }, [])).toBe('seller');
    expect(resolveCodCollector({ deliveryMethod: 'tcs' }, ['leopards'])).toBe('seller');
  });
  it('self / none -> seller', () => {
    expect(resolveCodCollector({ deliveryMethod: 'self' }, ['tcs'])).toBe('seller');
    expect(resolveCodCollector({ deliveryMethod: null }, ['tcs'])).toBe('seller');
    expect(resolveCodCollector(null, ['tcs'])).toBe('seller');
  });
  it("a store the admin set to fulfillmentMode 'platform' is platform even without a courier", () => {
    expect(resolveCodCollector({ deliveryMethod: 'self', fulfillmentMode: 'platform' }, [])).toBe('platform');
    expect(resolveCodCollector({ deliveryMethod: 'tcs', fulfillmentMode: 'platform' }, [])).toBe('platform');
  });
});

describe('ShippingQuoteService.codCollectors (admin switch AND credentials)', () => {
  const svc = new ShippingQuoteService();
  const adapters = (configured: string[]) => () => (['tcs', 'leopards', 'postex'] as const).map((id) => ({ id, label: id, isConfigured: () => configured.includes(id) })) as any;
  const stores = [{ _id: 's1', deliveryMethod: 'tcs' }, { _id: 's2', deliveryMethod: 'self' }, { _id: 's3', deliveryMethod: 'auto' }];

  it('enabled AND configured -> platform for courier / auto stores, seller for self', () => {
    svc.buildAdapters = adapters(['tcs']);
    const m = svc.codCollectors(stores, settings({ tcs: true }));
    expect([m.get('s1'), m.get('s2'), m.get('s3')]).toEqual(['platform', 'seller', 'platform']);
  });
  it('enabled but NOT configured -> seller', () => {
    svc.buildAdapters = adapters([]);
    const m = svc.codCollectors(stores, settings({ tcs: true }));
    expect([m.get('s1'), m.get('s3')]).toEqual(['seller', 'seller']);
  });
  it('configured but NOT enabled by admin -> seller', () => {
    svc.buildAdapters = adapters(['tcs']);
    const m = svc.codCollectors(stores, settings({}));
    expect([m.get('s1'), m.get('s3')]).toEqual(['seller', 'seller']);
  });
});

describe('cashMode (codCollector wins, then fulfillmentMode, then seller)', () => {
  it('uses the collector snapshot first', () => {
    expect(cashMode({ codCollector: 'platform', fulfillmentMode: 'seller' })).toBe('platform');
    expect(cashMode({ codCollector: 'seller', fulfillmentMode: 'platform' })).toBe('seller');
  });
  it('old orders (no collector) fall back to fulfillmentMode, then seller', () => {
    expect(cashMode({ fulfillmentMode: 'platform' })).toBe('platform');
    expect(cashMode({ codCollector: null, fulfillmentMode: 'seller' })).toBe('seller');
    expect(cashMode({})).toBe('seller');
    expect(cashMode(null)).toBe('seller');
  });
  it('finance path: platform collector is NOT seller-collected (sale credit), seller collector is (commission debit only)', () => {
    expect(isSellerCollectedCod('cash_on_delivery', { fulfillmentMode: cashMode({ codCollector: 'platform' }) })).toBe(false);
    expect(isSellerCollectedCod('cash_on_delivery', { fulfillmentMode: cashMode({ codCollector: 'seller' }) })).toBe(true);
    expect(isSellerCollectedCod('stripe', { fulfillmentMode: 'seller' })).toBe(false);
  });
});
