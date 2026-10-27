import { DisplayRateService, cleanRates } from './display-rate.service';
import { countryFromHeaders, currencyForCountry } from './country-currency.util';

const table = { result: 'success', rates: { USD: 1, PKR: 280, AED: 3.67, GBP: 0.78, EUR: 0.9, INR: 83 }, time_next_update_unix: 0 };
const json = (b: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b }) as any;

describe('display rates', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('keeps only finite positive rates, whatever the size of the change', () => {
    expect(cleanRates({ aed: 3.7, XXX: 0, BAD: -1, NAN: NaN, str: '3', GBP: 900 })).toEqual({ AED: 3.7, GBP: 900 });
  });

  it('expires the cache at the provider next-update time', async () => {
    const now = 1_000_000_000_000;
    global.fetch = jest.fn().mockResolvedValue(json({ ...table, time_next_update_unix: (now + 20 * 60_000) / 1000 })) as any;
    const svc = new DisplayRateService();
    expect((await svc.getRates(now))?.rates.AED).toBe(3.67);
    await svc.getRates(now + 10 * 60_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await svc.getRates(now + 21 * 60_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('serves last-known-good (stale) when every provider fails, null when there never was one', async () => {
    const now = 1_000_000_000_000;
    global.fetch = jest.fn().mockResolvedValueOnce(json(table)) as any;
    const svc = new DisplayRateService();
    await svc.getRates(now);
    global.fetch = jest.fn().mockResolvedValue(json({}, false)) as any;
    const r = await svc.getRates(now + 7 * 3600_000);
    expect(r?.stale).toBe(true);
    expect(r?.rates.GBP).toBe(0.78);
    expect(await new DisplayRateService().getRates(now)).toBeNull();
  });

  it('maps countries to currencies and reads CDN headers', () => {
    expect(currencyForCountry('ae')).toBe('AED');
    expect(currencyForCountry('DE')).toBe('EUR');
    expect(currencyForCountry('ZZ')).toBeNull();
    expect(countryFromHeaders({ 'x-vercel-ip-country': 'GB' })).toBe('GB');
    expect(countryFromHeaders({ 'cf-ipcountry': 'XX' })).toBeNull();
  });
});
