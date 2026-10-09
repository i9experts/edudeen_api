import { ExchangeRateService } from './exchange-rate.service';

// Regression: the PKR refresh used to call Frankfurter (ECB), which does not publish PKR and
// answers HTTP 404. The provider chain must fall through to a provider that has PKR, and must
// refuse (throw) rather than return an unusable number.
describe('ExchangeRateService.fetchProviderRate', () => {
  const service = new ExchangeRateService({} as any, {} as any, {} as any);
  const call = (currency: string): Promise<number> => (service as any).fetchProviderRate(currency);
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

  it('uses the first provider that returns a usable PKR rate', async () => {
    global.fetch = jest.fn().mockResolvedValue(json({ result: 'success', rates: { PKR: 281.5 } })) as any;
    await expect(call('PKR')).resolves.toBe(281.5);
  });

  it('falls back when a provider answers 404', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(json({}, false, 404))
      .mockResolvedValueOnce(json({ usd: { pkr: 280.1 } })) as any;
    await expect(call('PKR')).resolves.toBe(280.1);
  });

  it('throws (never returns a made-up rate) when every provider fails or answers garbage', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(json({}, false, 404))
      .mockResolvedValueOnce(json({ usd: { pkr: 'NaN' } }))
      .mockResolvedValueOnce(json({ rates: { PKR: -5 } })) as any;
    await expect(call('PKR')).rejects.toThrow(/No FX provider returned a PKR rate/);
  });
});
