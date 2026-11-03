process.env.COURIER_DELIVERY_ENABLED = 'true'; // these specs cover the courier-on paths (the switch is off by default)
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { CheckoutService } from './checkout.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ShippingQuoteService } from './shipping-quote.service';
import { sanitizeCourierSettings } from './courier-settings.util';
import { sanitizeRateTable } from './shipping-rate.util';

const SNAP = [{ currency: 'PKR', ratePerUSD: 280 }, { currency: 'USD', ratePerUSD: 1 }];
const item = (productId: string) => ({ storeId: 'A', type: 'physical', productId, variantId: `v-${productId}`, quantity: 1, totalPrice: 1000, currency: 'PKR' });

function setup(store: any, opts: { rates?: boolean; liveFee?: number | null } = {}) {
  const items = [item('p1')];
  const checkout: any = { _id: 'c1', userId: 'u1', status: 'pending', currency: 'PKR', subtotal: 1000, fxSnapshots: SNAP, items, expiredAt: null };
  const update = jest.fn().mockResolvedValue({});
  const repos: any = {
    checkoutModel: { findOne: jest.fn().mockResolvedValue(checkout), findByIdAndUpdate: update },
    shippingZoneModel: { findOne: jest.fn().mockResolvedValue({ _id: 'z1', shippingPrice: 300, city: 'Karachi', province: 'Sindh' }) },
    storeModel: { find: jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'A', baseCurrency: 'PKR', shipFrom: { city: 'Lahore', province: 'Punjab' }, ...store }] }) })) },
    productModel: { find: jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'p1' }] }) })) },
    productVariantModel: { find: jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'v-p1', shippingWeight: '0.6 kg' }] }) })) },
  };
  const table = sanitizeRateTable({ enabled: opts.rates === true, routes: { sameCity: { slabs: [{ upToKg: 1, feePKR: 100 }] }, sameProvince: { slabs: [{ upToKg: 1, feePKR: 150 }] }, national: { slabs: [{ upToKg: 1, feePKR: 400 }] } } });
  const shippingRates: any = {
    get: jest.fn().mockResolvedValue(table),
    getCourierSettings: jest.fn().mockResolvedValue(sanitizeCourierSettings({ enabled: { tcs: true }, useLiveRates: true, markupPct: 10 })),
  };
  const quotes = new ShippingQuoteService();
  quotes.buildAdapters = () => [{ id: 'tcs', label: 'TCS', isConfigured: () => true, quote: async () => (opts.liveFee == null ? { ok: false, error: 'x' } : { ok: true, feePKR: opts.liveFee, service: 'Overnight', etaDays: 2 }) } as any];
  const svc = new CheckoutService({ repositories: repos } as any, {} as any, {} as any, new ExchangeRateService({} as any, {} as any, {} as any), {} as any, {} as any, undefined, shippingRates, quotes);
  const run = async () => (await svc.addShippingInCheckout('u1', { checkoutId: 'c1', shippingZoneId: 'z1' })).data.shippingByStore[0];
  return { run, update };
}

describe('addShippingInCheckout with Store.deliveryMethod', () => {
  it('null method = today\'s behaviour (zone fee, no courier meta)', async () => {
    const line = await setup({ deliveryMethod: null }).run();
    expect(line).toEqual({ storeId: 'A', baseFee: 300, discountPercent: 0, fee: 300, giftWrapFee: 0 });
  });

  it('null method + rate table on = slab fee, no courier meta (Phase 1)', async () => {
    const line = await setup({ deliveryMethod: null }, { rates: true }).run();
    expect(line.baseFee).toBe(400);
    expect(line.source).toBeUndefined();
  });

  it("'self' with a flat fee charges the seller's fee and ignores the rate table", async () => {
    const line = await setup({ deliveryMethod: 'self', deliverySettings: { enabled: true, fee: 120, freeOverAmount: null } }, { rates: true }).run();
    expect(line).toMatchObject({ baseFee: 120, fee: 120, source: 'self', courier: null });
  });

  it("'self' free over amount -> free", async () => {
    const line = await setup({ deliveryMethod: 'self', deliverySettings: { enabled: true, fee: 120, freeOverAmount: 900 } }).run();
    expect(line).toMatchObject({ baseFee: 0, source: 'self' });
  });

  it("'self' without delivery settings falls back to the platform zone fee", async () => {
    const line = await setup({ deliveryMethod: 'self' }, { rates: true }).run();
    expect(line).toMatchObject({ baseFee: 300, source: 'zone' });
  });

  it('courier with a live quote: quote + markup, records courier/service/eta', async () => {
    const line = await setup({ deliveryMethod: 'tcs', deliverySettings: { enabled: true, fee: 50, freeOverAmount: null } }, { liveFee: 200 }).run();
    expect(line).toMatchObject({ baseFee: 220, fee: 220, courier: 'tcs', service: 'Overnight', etaDays: 2, source: 'live' });
  });

  it('courier live fails -> slab table, courier remembered; slab off -> zone fee', async () => {
    expect(await setup({ deliveryMethod: 'tcs' }, { rates: true, liveFee: null }).run()).toMatchObject({ baseFee: 400, courier: 'tcs', source: 'slab' });
    expect(await setup({ deliveryMethod: 'tcs' }, { rates: false, liveFee: null }).run()).toMatchObject({ baseFee: 300, courier: 'tcs', source: 'zone' });
  });
});
