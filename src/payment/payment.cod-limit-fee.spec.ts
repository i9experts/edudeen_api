process.env.COURIER_DELIVERY_ENABLED = 'true'; // these specs cover the courier-on paths (the switch is off by default)
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { PaymentService } from './payment.service';
import { shippingCreditFor } from '../finance/finance.service';
import { ShippingQuoteService } from '../checkout/shipping-quote.service';

// 1 USD = 280 PKR
const convert = (n: number, from: string, to: string) => (from === to ? n : from === 'PKR' && to === 'USD' ? n / 280 : n * 280);

const physical = (storeId: string, n: number, price = 10) => ({ type: 'physical', storeId, variantId: `v${n}`, quantity: 1, name: `Book ${n}`, totalPrice: price, currency: 'USD' });
const digital = (storeId: string, n: number) => ({ type: 'digital', storeId, variantId: `v${n}`, quantity: 1, name: `PDF ${n}`, totalPrice: 10, currency: 'USD' });

// platformStores: stores whose COD cash goes to Edudeen (admin fulfillmentMode 'platform' stands in for a usable courier). Default = all.
function makeService(items: any[], cod: { maxPerPackagePKR: number | null; feePerPackagePKR: number }, shipping = 2, platformStores?: string[]) {
  const physicalStores = [...new Set(items.filter((i) => i.type === 'physical').map((i) => i.storeId))];
  const shippingByStore = physicalStores.map((storeId) => ({ storeId, fee: shipping, baseFee: shipping, discountPercent: 0 }));
  const shippingFee = shipping * physicalStores.length;
  const checkout: any = {
    _id: 'c1', userId: 'u1', status: 'pending', expiredAt: null, currency: 'USD',
    totalAmount: items.reduce((s, i) => s + i.totalPrice, 0) + shippingFee, shippingFee, shippingByStore, codFeeTotal: 0,
    orderPlacementStartedAt: null, fxSnapshots: [], items,
  };
  const repos: any = {
    checkoutModel: {
      findOne: jest.fn().mockImplementation(async () => ({ ...checkout })),
      findOneAndUpdate: jest.fn().mockImplementation(async () => ({ ...checkout })),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
    },
    storeModel: {
      find: jest.fn((f: any) => ({ select: () => ({ lean: async () => (f.codEnabled === false ? [] : [...new Set(items.map((i: any) => i.storeId))].map((_id) => ({ _id, fulfillmentMode: !platformStores || platformStores.includes(_id as string) ? 'platform' : 'seller' }))) }) })),
    },
    productVariantModel: {
      findOne: jest.fn().mockResolvedValue({ stock: 10, unlimitedStock: false }),
      find: jest.fn((f: any) => ({ select: () => ({ lean: async () => (f?._id?.$in ?? []).map((_id: string) => ({ _id, stock: 10, unlimitedStock: false })) }) })),
    },
    paymentTransactionModel: { create: jest.fn().mockResolvedValue({}), findOne: jest.fn().mockResolvedValue(null) },
    orderModel: {}, addressModel: {}, cartModel: {},
  };
  const adminConfig: any = { getCodConfig: jest.fn().mockResolvedValue(cod) };
  const fx: any = { convertWithSnapshots: jest.fn(convert) };
  const svc: any = new PaymentService(
    { repositories: repos } as any, {} as any, { get: jest.fn() } as any, {} as any, {} as any,
    adminConfig, fx, { log: jest.fn() } as any, {} as any, {} as any, {} as any,
  );
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  svc.cancelPendingCardIntents = jest.fn().mockResolvedValue(undefined);
  svc.assertStripeConfigured = jest.fn(() => ({}));
  // Capture the checkout the order is built from (the fee must already be inside it).
  svc.createOrder = jest.fn().mockImplementation(async (_u: any, co: any) => {
    const orders = [{ _id: 'o1', sellerOrders: physicalStores.map((storeId) => ({ storeId, fulfillmentType: 'physical', items: [], subtotal: 10, shippingFee: (co.shippingByStore.find((l: any) => l.storeId === storeId)?.fee ?? 0), codAmount: 10 + (co.shippingByStore.find((l: any) => l.storeId === storeId)?.fee ?? 0) })) }];
    return orders;
  });
  return { svc, repos, adminConfig };
}

describe('COD limit (per package)', () => {
  it('codPayment refuses with a readable 400 when ANY package is over the limit, and places nothing', async () => {
    // limit 2800 PKR = $10; each package = 10 + 2 shipping = 12
    const { svc, repos } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: 2800, feePerPackagePKR: 0 });
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(/Cash on Delivery is limited to 2800 PKR per package/);
    expect(svc.createOrder).not.toHaveBeenCalled();
    expect(repos.checkoutModel.findOneAndUpdate).not.toHaveBeenCalled(); // not even claimed
  });

  it('packages under the limit are placed', async () => {
    const { svc } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: 3500, feePerPackagePKR: 0 }); // $12.5
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).resolves.toBeDefined();
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it("initiatePayment 'split' re-checks the limit before any Stripe call", async () => {
    const { svc } = makeService([physical('A', 1), digital('C', 3)], { maxPerPackagePKR: 2800, feePerPackagePKR: 0 });
    const stripeCreate = jest.fn();
    svc.assertStripeConfigured = jest.fn(() => ({ paymentIntents: { create: stripeCreate, retrieve: stripeCreate, cancel: stripeCreate } }));
    await expect(svc.initiatePayment('u1', { checkoutId: 'c1', paymentMode: 'split' })).rejects.toThrow(/Cash on Delivery is limited/);
    expect(stripeCreate).not.toHaveBeenCalled();
  });

  it("'full' online payment is NOT affected by the COD limit", async () => {
    const { svc } = makeService([physical('A', 1), digital('C', 3)], { maxPerPackagePKR: 2800, feePerPackagePKR: 0 });
    const err: any = await svc.initiatePayment('u1', { checkoutId: 'c1', paymentMode: 'full' }).catch((e: any) => e);
    expect(String(err?.message)).not.toMatch(/Cash on Delivery/);
  });

  it('nothing configured: behaviour unchanged (no fee, createOrder gets the original totals)', async () => {
    const { svc, repos } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: null, feePerPackagePKR: 0 });
    await svc.codPayment('u1', { checkoutId: 'c1' });
    const co = svc.createOrder.mock.calls[0][1];
    expect(co.totalAmount).toBe(24);
    expect(co.shippingByStore.map((l: any) => l.fee)).toEqual([2, 2]);
    expect(repos.checkoutModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', { status: 'completed' });
  });
});

describe('COD fee (per package)', () => {
  it('is folded into every package shipping line BEFORE the order is created, and saved with the completed checkout', async () => {
    const { svc, repos } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: null, feePerPackagePKR: 280 }); // $1 each
    await svc.codPayment('u1', { checkoutId: 'c1' });
    const co = svc.createOrder.mock.calls[0][1];
    expect(co.shippingByStore.map((l: any) => l.fee)).toEqual([3, 3]);
    expect(co.shippingFee).toBe(6);
    expect(co.totalAmount).toBe(26);
    expect(co.codFeeTotal).toBe(2);
    expect(repos.checkoutModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'completed', totalAmount: 26, shippingFee: 6, codFeeTotal: 2 }));
  });

  it('is idempotent: running the preparation again on a checkout that already carries it adds nothing', async () => {
    const { svc } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: null, feePerPackagePKR: 280 });
    const co: any = { currency: 'USD', fxSnapshots: [], items: [physical('A', 1), physical('B', 2)], shippingByStore: [{ storeId: 'A', fee: 2 }, { storeId: 'B', fee: 2 }], shippingFee: 4, totalAmount: 24, codFeeTotal: 0 };
    expect(await svc.prepareCodCheckout(co)).not.toBeNull();
    expect(co.totalAmount).toBe(26);
    expect(await svc.prepareCodCheckout(co)).toBeNull();
    expect(co.totalAmount).toBe(26); // not 28
  });

  it('is charged ONLY on packages Edudeen collects (seller-rider packages carry no fee)', async () => {
    const { svc, repos } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: null, feePerPackagePKR: 280 }, 2, ['B']);
    await svc.codPayment('u1', { checkoutId: 'c1' });
    const co = svc.createOrder.mock.calls[0][1];
    expect(co.shippingByStore.map((l: any) => [l.storeId, l.fee])).toEqual([['A', 2], ['B', 3]]);
    expect(co.totalAmount).toBe(25);
    expect(co.codFeeTotal).toBe(1);
    expect(repos.checkoutModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', expect.objectContaining({ codFeeTotal: 1, totalAmount: 25 }));
  });

  it('no Edudeen-collected package: no fee at all and the checkout is saved untouched', async () => {
    const { svc, repos } = makeService([physical('A', 1)], { maxPerPackagePKR: null, feePerPackagePKR: 280 }, 2, []);
    await svc.codPayment('u1', { checkoutId: 'c1' });
    const co = svc.createOrder.mock.calls[0][1];
    expect(co.totalAmount).toBe(12);
    expect(co.codFeeTotal).toBe(0);
    expect(repos.checkoutModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', { status: 'completed' });
  });

  it('fee and order collector come from ONE resolution per checkout (cached), so they cannot disagree', async () => {
    const { svc, repos } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: null, feePerPackagePKR: 280 }, 2, ['A']);
    const co: any = { currency: 'USD', fxSnapshots: [], items: [physical('A', 1), physical('B', 2)], shippingByStore: [], shippingFee: 0, totalAmount: 20, codFeeTotal: 0 };
    await svc.prepareCodCheckout(co);
    const first = await svc.codCollectorsFor(co);
    expect([...first.entries()]).toEqual([['A', 'platform'], ['B', 'seller']]);
    // even if the store data changes meanwhile, the same checkout object keeps its decision
    repos.storeModel.find = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
    expect(await svc.codCollectorsFor(co)).toBe(first);
  });

  it('a courier that is usable at order time makes the package Edudeen-collected (fee applies)', async () => {
    const { svc } = makeService([physical('A', 1)], { maxPerPackagePKR: null, feePerPackagePKR: 280 }, 2, []);
    svc.databaseService.repositories.storeModel.find = jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'A', deliveryMethod: 'tcs', fulfillmentMode: 'seller' }] }) }));
    svc.shippingRates = { getCourierSettings: async () => ({ enabled: { tcs: true, leopards: false, postex: false }, useLiveRates: false, markupPct: 0, handlingFeePKR: 0 }) };
    const q = new ShippingQuoteService();
    q.buildAdapters = () => [{ id: 'tcs', label: 'TCS', isConfigured: () => true }] as any;
    svc.shippingQuotes = q;
    const co: any = { currency: 'USD', fxSnapshots: [], items: [physical('A', 1)], shippingByStore: [{ storeId: 'A', fee: 2 }], shippingFee: 2, totalAmount: 12, codFeeTotal: 0 };
    expect(await svc.prepareCodCheckout(co)).not.toBeNull();
    expect(co.codFeeTotal).toBe(1);
    expect((await svc.codCollectorsFor(co)).get('A')).toBe('platform');
    // courier credentials removed -> the same store is seller-collected, no fee
    q.buildAdapters = () => [{ id: 'tcs', label: 'TCS', isConfigured: () => false }] as any;
    const co2: any = { currency: 'USD', fxSnapshots: [], items: [physical('A', 1)], shippingByStore: [{ storeId: 'A', fee: 2 }], shippingFee: 2, totalAmount: 12, codFeeTotal: 0 };
    expect(await svc.prepareCodCheckout(co2)).toBeNull();
    expect((await svc.codCollectorsFor(co2)).get('A')).toBe('seller');
  });

  it('a failed placement leaves nothing persisted (fee only lives in memory until the checkout completes)', async () => {
    const { svc, repos } = makeService([physical('A', 1)], { maxPerPackagePKR: null, feePerPackagePKR: 280 });
    svc.createOrder = jest.fn().mockRejectedValue(new Error('Stock not available'));
    svc.releaseCheckoutPlacementClaim = jest.fn().mockResolvedValue(undefined);
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow('Stock not available');
    expect(repos.checkoutModel.findByIdAndUpdate).not.toHaveBeenCalledWith('c1', expect.objectContaining({ codFeeTotal: expect.anything() }));
  });

  it('single package: the one transaction row carries the fee-inclusive total, status completed (unchanged shape)', async () => {
    const { svc, repos } = makeService([physical('A', 1)], { maxPerPackagePKR: null, feePerPackagePKR: 280 });
    await svc.codPayment('u1', { checkoutId: 'c1' });
    expect(repos.paymentTransactionModel.create).toHaveBeenCalledTimes(1);
    expect(repos.paymentTransactionModel.create.mock.calls[0][0]).toMatchObject({ paymentType: 'cash_on_delivery', amount: 13, status: 'completed', paidAt: null });
  });

  it('the fee is never credited to the seller: shippingCreditFor is 0 on COD even though the fee sits in settlementShippingFee', () => {
    expect(shippingCreditFor({ paymentType: 'cash_on_delivery' }, { fulfillmentType: 'physical', fulfillmentMode: 'seller', settlementShippingFee: 3 })).toBe(0);
  });
});

describe('COD payment record per package', () => {
  it('2+ packages: one pending row per package (amount = that package codAmount, own storeId, paidAt null)', async () => {
    const { svc, repos } = makeService([physical('A', 1), physical('B', 2)], { maxPerPackagePKR: null, feePerPackagePKR: 280 });
    await svc.codPayment('u1', { checkoutId: 'c1' });
    const rows = repos.paymentTransactionModel.create.mock.calls.map((c: any) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => [r.storeId, r.amount, r.status, r.paidAt])).toEqual([
      ['A', 13, 'pending', null],
      ['B', 13, 'pending', null],
    ]);
    expect(rows.every((r: any) => r.paymentType === 'cash_on_delivery' && r.checkoutId === 'c1' && r.orderIds[0] === 'o1')).toBe(true);
  });
});

describe('PaymentService.formatOrder carries the per-package payment fields', () => {
  it('exposes packages[] (packageIsPaid, packagePaidAt, codAmount) and paymentStatus', () => {
    const { svc } = makeService([physical('A', 1)], { maxPerPackagePKR: null, feePerPackagePKR: 0 });
    const paidAt = new Date('2026-01-02T00:00:00Z');
    const out = svc.formatOrder({
      _id: 'o1', orderNumber: 'ORD-1', createdAt: new Date(), paymentType: 'cash_on_delivery', isPaid: false, paymentStatus: 'partially_paid', orderStatus: 'pending',
      currency: 'PKR', subtotal: 20, shippingFee: 4, totalAmount: 24,
      sellerOrders: [
        { storeId: 'A', status: 'completed', isPaid: true, paidAt, codAmount: 12, items: [] },
        { storeId: 'B', status: 'pending', isPaid: false, paidAt: null, codAmount: 12, items: [] },
      ],
    });
    expect(out.paymentStatus).toBe('partially_paid');
    expect(out.packages).toEqual([
      { storeId: 'A', status: 'completed', packageIsPaid: true, packagePaidAt: paidAt, codAmount: 12, codCollector: null },
      { storeId: 'B', status: 'pending', packageIsPaid: false, packagePaidAt: null, codAmount: 12, codCollector: null },
    ]);
  });
});
