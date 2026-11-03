import { codPackagesOf, evaluateCod, withCodFee } from './cod-rules.util';

// 1 USD = 280 PKR in these tests.
const convert = (n: number, from: string, to: string) => (from === to ? n : from === 'PKR' && to === 'USD' ? n / 280 : n * 280);

const item = (storeId: string, totalPrice: number, type = 'physical') => ({ type, storeId, totalPrice, currency: 'USD' });
const checkout = (over: any = {}): any => ({
  currency: 'USD',
  items: [item('A', 10), item('B', 20)],
  shippingByStore: [{ storeId: 'A', fee: 2, baseFee: 2, discountPercent: 0 }, { storeId: 'B', fee: 3, baseFee: 3, discountPercent: 0 }],
  shippingFee: 5,
  totalAmount: 35,
  ...over,
});

describe('codPackagesOf', () => {
  it('one package per physical store: its items plus its own shipping (digital lines ignored)', () => {
    const pk = codPackagesOf(checkout({ items: [item('A', 10), item('A', 5), item('B', 20), item('C', 9, 'digital')] }), convert);
    expect(pk).toEqual([
      { storeId: 'A', itemsTotal: 15, shipping: 2, total: 17 },
      { storeId: 'B', itemsTotal: 20, shipping: 3, total: 23 },
    ]);
  });
  it('a legacy checkout (flat shippingFee, no per-store lines) puts it on the first store', () => {
    const pk = codPackagesOf(checkout({ shippingByStore: [], shippingFee: 4 }), convert);
    expect(pk.map((p) => p.shipping)).toEqual([4, 0]);
  });
});

describe('evaluateCod', () => {
  it('nothing configured: available, no conversion needed, identical to before', () => {
    const noConvert = () => { throw new Error('must not be called'); };
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: null, feePerPackagePKR: 0 }, noConvert);
    expect(ev).toMatchObject({ available: true, reason: null, maxPerPackage: null, feePerPackage: 0, feeTotal: 0 });
  });
  it('a package over the limit makes COD unavailable, with a reason', () => {
    // limit 5600 PKR = $20; package B = 20 + 3 = 23 > 20
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: 5600, feePerPackagePKR: 0 }, convert);
    expect(ev.available).toBe(false);
    expect(ev.overLimitStoreIds).toEqual(['B']);
    expect(ev.reason).toMatch(/limited to 5600 PKR per package/);
  });
  it('the limit is PER PACKAGE: two packages that are each under it are fine even if the sum is above', () => {
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: 7000, feePerPackagePKR: 0 }, convert); // $25 each
    expect(ev.available).toBe(true);
  });
  it('fee is converted with the checkout rate and counted per package', () => {
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: null, feePerPackagePKR: 280 }, convert);
    expect(ev).toMatchObject({ available: true, feePerPackage: 1, packageCount: 2, feeTotal: 2 });
  });
  it('fee only on the packages Edudeen collects (feeStoreIds), with feeByStore per store', () => {
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: null, feePerPackagePKR: 280 }, convert, ['B']);
    expect(ev).toMatchObject({ feePerPackage: 1, packageCount: 2, feeTotal: 1, feeByStore: { B: 1 } });
    const none = evaluateCod(checkout(), { maxPerPackagePKR: null, feePerPackagePKR: 280 }, convert, []);
    expect(none).toMatchObject({ feeTotal: 0, feeByStore: {} });
  });
  it('the per-package limit still applies to packages without a fee', () => {
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: 5600, feePerPackagePKR: 280 }, convert, []);
    expect(ev.available).toBe(false);
    expect(ev.overLimitStoreIds).toEqual(['B']);
  });
  it('no PKR rate on the checkout: refuses COD instead of guessing', () => {
    const ev = evaluateCod(checkout(), { maxPerPackagePKR: 1000, feePerPackagePKR: 0 }, () => { throw new Error('no rate'); });
    expect(ev.available).toBe(false);
  });
});

describe('withCodFee', () => {
  it('adds the fee to every physical package line and to shippingFee / totalAmount', () => {
    const co = checkout();
    const p = withCodFee(co, 1)!;
    expect(p.shippingByStore.map((l: any) => l.fee)).toEqual([3, 4]);
    expect(p.shippingFee).toBe(7);
    expect(p.totalAmount).toBe(37);
    expect(p.codFeeTotal).toBe(2);
  });
  it('is idempotent: a checkout that already carries the fee is not charged twice', () => {
    const co = checkout();
    const p = withCodFee(co, 1)!;
    Object.assign(co, { shippingByStore: p.shippingByStore, shippingFee: p.shippingFee, totalAmount: p.totalAmount, codFeeTotal: p.codFeeTotal });
    expect(withCodFee(co, 1)).toBeNull();
  });
  it('only the listed (Edudeen-collected) stores get the fee; none listed = nothing added', () => {
    const p = withCodFee(checkout(), 1, ['B'])!;
    expect(p.shippingByStore.map((l: any) => l.fee)).toEqual([2, 4]);
    expect(p.totalAmount).toBe(36);
    expect(p.codFeeTotal).toBe(1);
    expect(withCodFee(checkout(), 1, [])).toBeNull();
  });
  it('no fee configured: nothing to add', () => {
    expect(withCodFee(checkout(), 0)).toBeNull();
  });
  it('a store without a shipping line (no zones configured) gets one carrying just the fee', () => {
    const p = withCodFee(checkout({ shippingByStore: [], shippingFee: 0, totalAmount: 30 }), 1)!;
    expect(p.shippingByStore.map((l: any) => [l.storeId, l.fee])).toEqual([['A', 1], ['B', 1]]);
    expect(p.totalAmount).toBe(32);
  });
  it('legacy flat shipping is kept on its store and the fee is added on top', () => {
    const p = withCodFee(checkout({ shippingByStore: [], shippingFee: 4, totalAmount: 34 }), 1)!;
    expect(p.shippingByStore.map((l: any) => [l.storeId, l.fee])).toEqual([['A', 5], ['B', 1]]);
    expect(p.shippingFee).toBe(6);
  });
});
