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

function setup(items: any[]) {
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
      findOne: jest.fn().mockResolvedValue({ _id: 'z1', shippingPrice: 300, estimatedDeliveryTime: ' 2-3 days ' }),
    }, // PKR 300 per shipping line
    storeModel: {
      find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
    },
  };
  const svc = new CheckoutService(
    { repositories: repos } as any,
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
  return { run };
}

describe('addShippingInCheckout — one shipping line per store with physical items', () => {
  it('two physical stores pay the zone fee twice', async () => {
    const { run } = setup([line('A', 'physical', 1000), line('B', 'physical', 2000)]);
    const { res, saved } = await run();
    expect(res.shippingByStore).toEqual([
      { storeId: 'A', baseFee: 300, discountPercent: 0, fee: 300, giftWrapFee: 0 },
      { storeId: 'B', baseFee: 300, discountPercent: 0, fee: 300, giftWrapFee: 0 },
    ]);
    expect(res.shippingFee).toBe(600);
    expect(saved.totalAmount).toBe(3600); // 3000 + 600
  });

  it('REGRESSION: a single-store checkout costs exactly one zone fee', async () => {
    const plain = await setup([line('A', 'physical', 1000)]).run();
    expect(plain.res.shippingFee).toBe(300);
    expect(plain.saved.totalAmount).toBe(1300);
  });

  it('a store whose items are all digital gets no shipping line', async () => {
    const { run } = setup([line('A', 'physical', 1000), line('B', 'digital', 500)]);
    const { res } = await run();
    expect(res.shippingByStore.map((l: any) => l.storeId)).toEqual(['A']);
    expect(res.shippingFee).toBe(300);
  });

  it('snapshots the zone delivery estimate text onto the checkout (physical only)', async () => {
    const phys = await setup([line('A', 'physical', 1000)]).run();
    expect(phys.saved.shippingEstimate).toBe('2-3 days');
    expect(phys.res.shippingEstimate).toBe('2-3 days');
    const digital = await setup([line('A', 'digital', 1000)]).run();
    expect(digital.saved.shippingEstimate).toBeNull();
  });

  it('a digital-only checkout has no shipping', async () => {
    const { run } = setup([line('A', 'digital', 1000), line('B', 'digital', 500)]);
    const { res, saved } = await run();
    expect(res.shippingFee).toBe(0);
    expect(res.shippingByStore).toEqual([]);
    expect(saved.totalAmount).toBe(1500);
  });

  it("shippingFee is exactly the sum of the lines", async () => {
    const { run } = setup([line('A', 'physical', 1), line('B', 'physical', 1), line('C', 'physical', 1)]);
    const { res } = await run();
    expect(res.shippingFee).toBeCloseTo(
      res.shippingByStore.reduce((s: number, l: any) => s + l.fee, 0),
      2,
    );
    expect(res.shippingByStore).toHaveLength(3);
  });
});
