/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { CartService } from '../cart/cart.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const hex = (n: number) => String(n).padStart(24, '0');
const isHex = (v: any) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

/** Mimics Mongoose: an ObjectId `_id: {$in}` query with a non-ObjectId value throws a CastError. */
const castCheck = (ids: any[]) => {
  const bad = ids.find((i) => !isHex(i));
  if (bad !== undefined) {
    const e: any = new Error(`Cast to ObjectId failed for value "${bad}" (type string) at path "_id"`);
    e.name = 'CastError';
    throw e;
  }
};
const chain = (v: any) => {
  const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) };
  return c;
};

interface Seed { store: number; product: number; type: 'physical' | 'digital'; qty: number; deliveryFormat?: string }

function world(seeds: Seed[]) {
  const stores = new Map<string, any>();
  const carts: any[] = [];
  const products = new Map<string, any>();
  const variants = new Map<string, any>();
  for (const s of seeds) {
    const sid = hex(s.store);
    const pid = hex(1000 + s.product);
    const vid = hex(2000 + s.product);
    stores.set(sid, { _id: sid, status: 'active', codEnabled: true, name: `Store ${s.store}`, slug: `s${s.store}`, isDelete: false });
    products.set(pid, { _id: pid, storeId: sid, sellerId: hex(9), name: `P${s.product}`, type: s.type, deliveryFormat: s.deliveryFormat ?? 'download', status: 'active', isDelete: false, images: [] });
    variants.set(vid, { _id: vid, productId: pid, status: 'active', isDelete: false, price: 10, currency: 'USD', unlimitedStock: true, stock: 0, options: [] });
    let cart = carts.find((c) => c.storeId === sid);
    if (!cart) carts.push((cart = { userId: 'u1', storeId: sid, status: 'active', isDelete: false, items: [] }));
    cart.items.push({ productId: pid, productVariantId: vid, name: `P${s.product}`, quantity: s.qty, price: 10, currency: 'USD', images: [], options: [] });
  }
  const repos: any = {
    cartModel: {
      find: jest.fn(() => chain(carts)),
      findOne: jest.fn(async (f: any) => carts.find((c) => c.storeId === f.storeId) ?? null),
    },
    productModel: { find: jest.fn((f: any) => { castCheck(f._id.$in); return chain(f._id.$in.map((i: string) => products.get(i)).filter(Boolean)); }) },
    productVariantModel: { find: jest.fn((f: any) => { castCheck(f._id.$in); return chain(f._id.$in.map((i: string) => variants.get(i)).filter(Boolean)); }) },
    storeModel: { find: jest.fn((f: any) => { castCheck(f._id.$in); return chain([...stores.values()].filter((s) => f._id.$in.includes(s._id))); }) },
    sellerModel: { find: jest.fn(() => chain([])) },
    shippingZoneModel: { exists: jest.fn().mockResolvedValue(null) },
    addressModel: { findOne: jest.fn(() => ({ sort: () => Promise.resolve({ _id: 'a', isDefault: true, save: jest.fn() }), then: (r: any) => Promise.resolve({ _id: hex(77), isDefault: true }).then(r) })) },
    userModel: { findById: jest.fn(() => chain({ currencyPreference: 'USD' })) },
    checkoutModel: { create: jest.fn(async (doc: any) => ({ _id: 'co1', ...doc })) },
  };
  const fx = new ExchangeRateService({} as any, {} as any, {} as any);
  jest.spyOn(fx, 'buildSnapshots').mockImplementation(async (cs: string[]) => [...new Set(cs)].map((currency) => ({ currency, ratePerUSD: currency === 'USD' ? 1 : 280, effectiveFrom: new Date(), source: 'admin', exchangeRateId: null })) as any);
  const svc = new CheckoutService(
    { repositories: repos } as any,
    { getActiveCampaignsForStores: jest.fn().mockResolvedValue(new Map()) } as any,
    { isManualPaymentEnabled: jest.fn().mockResolvedValue(false), isManualTransferAvailable: jest.fn().mockResolvedValue(false) } as any,
    fx,
    {} as any,
    { getActiveDiscountsForStores: jest.fn().mockResolvedValue(new Map()) } as any,
  );
  return { svc, repos, carts };
}

// 1 digital qty 2 (legacy) + 1 physical course item + items from 3 stores.
const MIXED: Seed[] = [
  { store: 1, product: 1, type: 'digital', qty: 2 },
  { store: 2, product: 2, type: 'physical', qty: 3 },
  { store: 3, product: 3, type: 'digital', qty: 1, deliveryFormat: 'course' },
];

describe('createCheckout - mixed cart from 3 stores (the Internal server error)', () => {
  it('reaches the payment step: no CastError from the missing storeId, digital line is clamped to 1', async () => {
    const w = world(MIXED);
    const { data } = await w.svc.createCheckout('u1', { currencyPreference: 'USD' });
    const byProduct = Object.fromEntries(data.checkout.items.map((i: any) => [i.productId, i]));
    expect(byProduct[hex(1001)].quantity).toBe(1);
    expect(byProduct[hex(1001)].totalPrice).toBe(10);
    expect(byProduct[hex(1002)].quantity).toBe(3); // physical keeps its quantity
    expect(byProduct[hex(1003)].quantity).toBe(1);
    expect(data.checkout.subtotal).toBe(10 + 30 + 10);
    expect(data.allowedPaymentMethods).toContain('stripe');
    // no store lookup ever receives the string "undefined"
    for (const [filter] of w.repos.storeModel.find.mock.calls) expect(filter._id.$in).not.toContain('undefined');
  });

  it('Buy Now on a digital item with quantity 5 is charged once', async () => {
    const w = world(MIXED);
    const { data } = await w.svc.createCheckout('u1', { currencyPreference: 'USD', buyNow: { productId: hex(1001), variantId: hex(2001), quantity: 5 } });
    expect(data.checkout.items).toHaveLength(1);
    expect(data.checkout.items[0].quantity).toBe(1);
    expect(data.checkout.subtotal).toBe(10);
  });

  it('an explicit items[] quantity cannot raise a digital line either', async () => {
    const w = world(MIXED);
    const { data } = await w.svc.createCheckout('u1', { currencyPreference: 'USD', items: [{ productId: hex(1001), variantId: hex(2001), quantity: 4 }] });
    expect(data.checkout.items[0].quantity).toBe(1);
  });

  it('a cart that holds an invalid id is a 400 with a message, never a 500', async () => {
    const w = world(MIXED);
    w.carts[0].items[0].productId = 'not-an-object-id';
    const err: any = await w.svc.createCheckout('u1', { currencyPreference: 'USD' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String(err.message)).toMatch(/cart/i);
  });
});

describe('cart read: digital quantity normalizer', () => {
  it('getCart returns quantity 1 / total x1 for a digital line stored with quantity 2, physical unchanged', async () => {
    const w = world(MIXED);
    const svc: any = new CartService(
      { repositories: { ...w.repos, campaignModel: { find: () => chain([]) } } } as any,
    );
    const { data } = await svc.getCart('u1', hex(1));
    expect(data.items[0].quantity).toBe(1);
    expect(data.items[0].itemTotal).toBe(10);
    expect(data.totalItems).toBe(1);
    expect(data.totalPrice).toBe(10);
  });

  it('getBuyNowCart clamps a digital product to quantity 1', async () => {
    const lean = (v: any) => ({ lean: () => Promise.resolve(v), select: () => ({ lean: () => Promise.resolve(v) }) });
    const svc: any = Object.create(CartService.prototype);
    svc.databaseService = {
      repositories: {
        productModel: { findOne: jest.fn(() => lean({ _id: hex(1), storeId: hex(5), name: 'D', type: 'digital', images: [] })) },
        storeModel: { findOne: jest.fn(() => lean({ name: 'S', slug: 's' })) },
        productVariantModel: { findOne: jest.fn(() => lean({ _id: hex(2), price: 5, currency: 'USD', options: [] })) },
      },
    };
    svc.getCart = jest.fn().mockResolvedValue({ data: { items: [] } });
    await svc.getBuyNowCart('u1', hex(1), hex(2), '4');
    expect(svc.getCart).toHaveBeenCalledWith('u1', hex(5), { items: [expect.objectContaining({ quantity: 1 })] });
  });
});
