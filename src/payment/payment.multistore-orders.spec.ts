/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { PaymentService } from './payment.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { shippingCreditFor } from '../finance/finance.service';

const SNAPSHOTS = [
  { currency: 'PKR', ratePerUSD: 280 },
  { currency: 'USD', ratePerUSD: 1 },
];
const item = (
  storeId: string,
  type: 'physical' | 'digital',
  n: number,
  totalPrice: number,
  currency: string,
) => ({
  productId: `p${n}`,
  variantId: `v${n}`,
  sellerId: `seller-${storeId}`,
  storeId,
  type,
  name: `Item ${n}`,
  quantity: 1,
  price: totalPrice,
  totalPrice,
  currency,
  options: [],
});

/**
 * One PKR checkout across THREE stores:
 *   A (digital, PKR store, seller fulfilled)         PKR 1000
 *   B (physical, PKR store, PLATFORM fulfilled)      PKR 2000   shipping line 300
 *   C (physical, USD store, seller fulfilled)        USD 10 (= PKR 2800)   shipping line 150
 * subtotal 5800 + shipping 450 = 6250
 */
function build() {
  const checkout: any = {
    _id: 'chk1',
    userId: 'buyer1',
    currency: 'PKR',
    fxSnapshots: SNAPSHOTS,
    addressId: 'addr1',
    items: [
      item('A', 'digital', 1, 1000, 'PKR'),
      item('B', 'physical', 2, 2000, 'PKR'),
      item('C', 'physical', 3, 10, 'USD'),
    ],
    subtotal: 5800,
    shippingFee: 450,
    totalAmount: 6250,
    shippingByStore: [
      { storeId: 'B', fee: 300, baseFee: 300, discountPercent: 0 },
      { storeId: 'C', fee: 150, baseFee: 300, discountPercent: 50 },
    ],
    attributionSource: 'other',
  };
  const stores = [
    { _id: 'A', baseCurrency: 'PKR', fulfillmentMode: 'seller' },
    { _id: 'B', baseCurrency: 'PKR', fulfillmentMode: 'platform' },
    { _id: 'C', baseCurrency: 'USD', fulfillmentMode: 'seller' },
  ];
  const created: any[] = [];
  const orderModel: any = {
    find: jest.fn(async () => created.slice()), // what is already stored for this checkout
    create: jest.fn(async (doc: any) => {
      const o = { _id: `order${created.length + 1}`, ...doc };
      created.push(o);
      return o;
    }),
  };
  const repos: any = {
    productVariantModel: {
      findOne: jest.fn(() => ({
        select: () => ({ lean: async () => ({ unlimitedStock: true }) }),
      })),
      updateOne: jest.fn(),
    },
    productModel: { findByIdAndUpdate: jest.fn().mockResolvedValue({}) },
    storeModel: {
      find: jest.fn(() => ({ select: () => ({ lean: async () => stores }) })),
    },
    couponModel: { updateOne: jest.fn() },
    rewardVoucherModel: { updateOne: jest.fn() },
  };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const svc: any = Object.create(PaymentService.prototype);
  Object.assign(svc, {
    databaseService: { repositories: repos },
    exchangeRateService: new ExchangeRateService(
      {} as any,
      {} as any,
      {} as any,
    ),
    notificationsService: notifications,
    promotionsService: {
      recordConversions: jest.fn().mockResolvedValue(undefined),
    },
    giftCardsService: { redeemAtOrderPlacement: jest.fn() },
    activityLogService: { log: jest.fn() },
  });
  const addressModel: any = {
    findOne: jest.fn().mockResolvedValue({
      recipientName: 'R',
      phoneNumber: '1',
      addressLine1: 'x',
      city: 'c',
      state: 's',
      zipCode: 'z',
    }),
  };
  const place = (
    physicalPayment = { paymentType: 'stripe', isPaid: true },
    digitalPayment = { paymentType: 'stripe', isPaid: true },
  ) =>
    svc.createOrder(
      'buyer1',
      checkout,
      orderModel,
      addressModel,
      physicalPayment,
      digitalPayment,
    );
  return { place, created, notifications, checkout };
}

describe('createOrder — a multi-store checkout becomes up to 2 Orders (digital + physical), one sellerOrder per store', () => {
  it('has exactly that shape', async () => {
    const { place } = build();
    const orders = await place();
    expect(orders).toHaveLength(2);
    const physical = orders.find(
      (o: any) => o.sellerOrders[0].fulfillmentType === 'physical',
    );
    const digital = orders.find(
      (o: any) => o.sellerOrders[0].fulfillmentType === 'digital',
    );
    expect(physical.sellerOrders.map((so: any) => so.storeId).sort()).toEqual([
      'B',
      'C',
    ]);
    expect(digital.sellerOrders.map((so: any) => so.storeId)).toEqual(['A']);
    expect(orders.every((o: any) => o.checkoutId === 'chk1')).toBe(true);
  });

  it("INVARIANT: the Orders' totals add up to exactly what the buyer was charged", async () => {
    const { place, checkout } = build();
    const orders = await place();
    expect(
      orders.reduce((sum: number, o: any) => sum + o.totalAmount, 0),
    ).toBeCloseTo(checkout.totalAmount, 2);
    for (const o of orders) {
      expect(o.totalAmount).toBeCloseTo(o.subtotal + o.shippingFee, 2);
      // each Order's subtotal is the sum of its sub-orders' subtotals
      expect(o.subtotal).toBeCloseTo(
        o.sellerOrders.reduce((s: number, so: any) => s + so.subtotal, 0),
        2,
      );
    }
  });

  it("INVARIANT: shipping is per store — each sub-order carries its own line, and the Order's shipping is their sum (digital: none)", async () => {
    const { place, checkout } = build();
    const orders = await place();
    const physical = orders.find(
      (o: any) => o.sellerOrders[0].fulfillmentType === 'physical',
    );
    const digital = orders.find(
      (o: any) => o.sellerOrders[0].fulfillmentType === 'digital',
    );
    const line = (storeId: string) =>
      physical.sellerOrders.find((so: any) => so.storeId === storeId)
        .shippingFee;
    expect(line('B')).toBe(300);
    expect(line('C')).toBe(150);
    expect(physical.shippingFee).toBe(450);
    expect(physical.shippingFee).toBe(checkout.shippingFee);
    expect(digital.shippingFee).toBe(0);
    expect(digital.sellerOrders[0].shippingFee).toBe(0);
  });

  it("snapshots each store's fulfillment mode on its physical sub-order (digital has none)", async () => {
    const { place } = build();
    const orders = await place();
    const so = (id: string) =>
      orders
        .flatMap((o: any) => o.sellerOrders)
        .find((s: any) => s.storeId === id);
    expect(so('B').fulfillmentMode).toBe('platform');
    expect(so('C').fulfillmentMode).toBe('seller');
    expect(so('A').fulfillmentMode).toBeNull();
  });

  it('each seller is credited in their OWN currency: payout basis = their native sale, shipping line converted to their settlement currency, and only seller-fulfilled stores are paid shipping', async () => {
    const { place } = build();
    const orders = await place();
    const physical = orders.find(
      (o: any) => o.sellerOrders[0].fulfillmentType === 'physical',
    );
    const b = physical.sellerOrders.find((so: any) => so.storeId === 'B');
    const c = physical.sellerOrders.find((so: any) => so.storeId === 'C');
    expect(b.settlementCurrency).toBe('PKR');
    expect(b.settlementAmount).toBe(2000);
    expect(c.settlementCurrency).toBe('USD');
    expect(c.settlementAmount).toBe(10);
    expect(c.settlementShippingFee).toBeCloseTo(0.54, 2); // PKR 150 → USD
    // ledger rule (FinanceService.recordSale caller): platform-fulfilled B keeps its shipping with the platform
    expect(shippingCreditFor(physical, b)).toBe(0);
    expect(shippingCreditFor(physical, c)).toBeCloseTo(0.54, 2);
    // ...and on COD, the seller's courier collected the shipping cash, so nothing is credited
    expect(
      shippingCreditFor({ ...physical, paymentType: 'cash_on_delivery' }, c),
    ).toBe(0);
  });

  it('notifies each seller once per Order they have a sub-order in, for their own sub-order only; the buyer once per Order', async () => {
    const { place, notifications } = build();
    await place();
    const calls = notifications.notify.mock.calls.map((c: any[]) => c[0]);
    const sellers = calls.filter((n: any) => n.recipientRole === 'seller');
    expect(sellers.map((n: any) => n.recipientId).sort()).toEqual([
      'seller-A',
      'seller-B',
      'seller-C',
    ]);
    expect(sellers.every((n: any) => /for 1 item/.test(n.body))).toBe(true);
    expect(calls.filter((n: any) => n.recipientRole === 'user')).toHaveLength(
      2,
    );
  });

  it('a retried placement returns the already-created orders instead of creating more', async () => {
    const ctx = build();
    const first = await ctx.place();
    const again = await ctx.place();
    expect(again).toHaveLength(first.length);
    expect(ctx.created).toHaveLength(2); // still only the two Orders
  });
});
