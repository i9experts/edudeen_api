/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { CheckoutService } from './checkout.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const SNAP = [
  { currency: 'PKR', ratePerUSD: 280 },
  { currency: 'USD', ratePerUSD: 1 },
];
const line = (
  storeId: string,
  type: 'physical' | 'digital',
  totalPrice: number,
) => ({
  storeId,
  type,
  productId: `p-${storeId}-${type}`,
  totalPrice,
  currency: 'PKR',
});

/** benefits: storeId -> free-shipping benefit (discountPercent, optional minimum order in the checkout currency) */
function setup(
  items: any[],
  benefits: Record<string, { discountPercent: number; min?: number }> = {},
) {
  const checkout: any = {
    _id: 'c1',
    userId: 'u1',
    status: 'pending',
    currency: 'PKR',
    subtotal: items.reduce((s, i) => s + i.totalPrice, 0),
    fxSnapshots: SNAP,
    items,
    expiredAt: null,
  };
  const update = jest.fn().mockResolvedValue({});
  const repos: any = {
    checkoutModel: {
      findOne: jest.fn().mockResolvedValue(checkout),
      findByIdAndUpdate: update,
    },
    shippingZoneModel: {
      findOne: jest.fn().mockResolvedValue({ _id: 'z1', shippingPrice: 300 }),
    }, // PKR 300 per shipping line
  };
  const subs: any = {
    getActiveBenefits: jest.fn(async (_u: string, storeId: string) =>
      benefits[storeId] ? { benefits: [{ storeId }], planName: 'Plus' } : null,
    ),
    resolveShippingBenefit: jest.fn((b: any[]) => {
      const cfg = benefits[b[0].storeId];
      return {
        discountPercent: cfg.discountPercent,
        minOrderValueForShippingUSD: cfg.min ?? null,
      };
    }),
  };
  const svc = new CheckoutService(
    { repositories: repos } as any,
    subs,
    {} as any,
    {} as any,
    new ExchangeRateService({} as any, {} as any, {} as any),
    {} as any,
    {} as any,
  );
  const run = async () => {
    const res = await svc.addShippingInCheckout('u1', {
      checkoutId: 'c1',
      shippingZoneId: 'z1',
    });
    return { res: res.data, saved: update.mock.calls[0][1] };
  };
  return { run, subs };
}

describe('addShippingInCheckout — one shipping line per store with physical items', () => {
  it("two physical stores pay the zone fee twice; each store's free-shipping benefit applies to its own line only", async () => {
    const { run } = setup(
      [line('A', 'physical', 1000), line('B', 'physical', 2000)],
      { A: { discountPercent: 100 } },
    );
    const { res, saved } = await run();
    expect(res.shippingByStore).toEqual([
      { storeId: 'A', baseFee: 300, discountPercent: 100, fee: 0 },
      { storeId: 'B', baseFee: 300, discountPercent: 0, fee: 300 },
    ]);
    expect(res.shippingFee).toBe(300);
    expect(saved.totalAmount).toBe(3300); // 3000 + 300
  });

  it("REGRESSION: a single-store checkout costs exactly what it did (one zone fee, that store's benefit)", async () => {
    const plain = await setup([line('A', 'physical', 1000)]).run();
    expect(plain.res.shippingFee).toBe(300);
    expect(plain.saved.totalAmount).toBe(1300);
    const half = await setup([line('A', 'physical', 1000)], {
      A: { discountPercent: 50 },
    }).run();
    expect(half.res.shippingFee).toBe(150);
  });

  it('a store whose items are all digital gets no shipping line, even with a benefit', async () => {
    const { run } = setup(
      [line('A', 'physical', 1000), line('B', 'digital', 500)],
      { B: { discountPercent: 100 } },
    );
    const { res } = await run();
    expect(res.shippingByStore.map((l: any) => l.storeId)).toEqual(['A']);
    expect(res.shippingFee).toBe(300);
  });

  it('a digital-only checkout has no shipping', async () => {
    const { run, subs } = setup([
      line('A', 'digital', 1000),
      line('B', 'digital', 500),
    ]);
    const { res, saved } = await run();
    expect(res.shippingFee).toBe(0);
    expect(res.shippingByStore).toEqual([]);
    expect(saved.totalAmount).toBe(1500);
    expect(subs.getActiveBenefits).not.toHaveBeenCalled();
  });

  it("the benefit's minimum order value is checked against THAT store's subtotal, not the whole checkout's", async () => {
    // A's items total 1000 < min 1500, even though the checkout total (3000) is above it.
    const { run } = setup(
      [line('A', 'physical', 1000), line('B', 'physical', 2000)],
      {
        A: { discountPercent: 100, min: 1500 },
        B: { discountPercent: 100, min: 1500 },
      },
    );
    const { res } = await run();
    expect(res.shippingByStore).toEqual([
      { storeId: 'A', baseFee: 300, discountPercent: 0, fee: 300 }, // below its own minimum
      { storeId: 'B', baseFee: 300, discountPercent: 100, fee: 0 },
    ]);
  });

  it("shippingFee is exactly the sum of the lines (so the buyer is charged what the sellers' lines add up to)", async () => {
    const { run } = setup(
      [
        line('A', 'physical', 1),
        line('B', 'physical', 1),
        line('C', 'physical', 1),
      ],
      { B: { discountPercent: 33.33 } },
    );
    const { res } = await run();
    expect(res.shippingFee).toBeCloseTo(
      res.shippingByStore.reduce((s: number, l: any) => s + l.fee, 0),
      2,
    );
    expect(res.shippingByStore).toHaveLength(3);
  });
});
