import { AdminConfigService } from './admin-config.service';

// Card is "available" only when BOTH Stripe keys exist (API secret + API publishable, which must match the web VITE key).
describe('publicPaymentMethods card availability', () => {
  const saved = { s: process.env.STRIPE_SECRET_KEY, p: process.env.STRIPE_PUBLISHABLE_KEY };
  afterEach(() => {
    if (saved.s === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.s;
    if (saved.p === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY; else process.env.STRIPE_PUBLISHABLE_KEY = saved.p;
  });
  const call = () => (new AdminConfigService({ repositories: {} } as any, { log: jest.fn() } as any) as any).publicPaymentMethods({});

  it.each([
    ['sk_x', 'pk_x', true, true, true],
    ['sk_x', '', false, true, false],
    ['', 'pk_x', false, false, true],
    ['', '', false, false, false],
  ])('secret=%s publishable=%s', async (s, p, card, hasS, hasP) => {
    process.env.STRIPE_SECRET_KEY = s;
    process.env.STRIPE_PUBLISHABLE_KEY = p;
    const r = await call();
    expect(r.card).toBe(card);
    expect(r.cardKeys).toEqual({ secretKey: hasS, publishableKey: hasP });
  });
});
