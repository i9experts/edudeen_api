/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import {
  CheckoutService,
  MAX_CHECKOUT_LINES,
  MAX_CHECKOUT_STORES,
} from './checkout.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const chain = (v: any) => {
  const c: any = {
    select: () => c,
    sort: () => c,
    limit: () => c,
    lean: () => Promise.resolve(v),
    then: (r: any, j: any) => Promise.resolve(v).then(r, j),
  };
  return c;
};

interface Seed {
  storeId: string;
  productId: string;
  type?: 'physical' | 'digital';
  price?: number;
  currency?: string;
  qty?: number;
  storeStatus?: string;
  codEnabled?: boolean;
}

/** An in-memory marketplace: one cart per (user, store), a product + variant per line. */
function world(seeds: Seed[], opts: { userId?: string } = {}) {
  const userId = opts.userId ?? 'u1';
  const stores = new Map<string, any>();
  const carts: any[] = [];
  const products = new Map<string, any>();
  const variants = new Map<string, any>();
  for (const s of seeds) {
    if (!stores.has(s.storeId))
      stores.set(s.storeId, {
        _id: s.storeId,
        status: s.storeStatus ?? 'active',
        codEnabled: s.codEnabled ?? true,
        name: `Store ${s.storeId}`,
        slug: s.storeId,
        isDelete: false,
      });
    products.set(s.productId, {
      _id: s.productId,
      storeId: s.storeId,
      sellerId: `seller-${s.storeId}`,
      name: `Product ${s.productId}`,
      type: s.type ?? 'digital',
      status: 'active',
      isDelete: false,
      images: [],
    });
    variants.set(`v-${s.productId}`, {
      _id: `v-${s.productId}`,
      productId: s.productId,
      status: 'active',
      isDelete: false,
      price: s.price ?? 10,
      currency: s.currency ?? 'USD',
      unlimitedStock: true,
      stock: 0,
      options: [],
    });
    let cart = carts.find((c) => c.storeId === s.storeId);
    if (!cart)
      carts.push(
        (cart = {
          userId,
          storeId: s.storeId,
          status: 'active',
          isDelete: false,
          items: [],
        }),
      );
    cart.items.push({
      productId: s.productId,
      productVariantId: `v-${s.productId}`,
      name: `Product ${s.productId}`,
      quantity: s.qty ?? 1,
      price: s.price ?? 10,
    });
  }
  const created: any[] = [];
  const repos: any = {
    cartModel: {
      find: jest.fn((f: any) =>
        chain(
          carts.filter(
            (c) =>
              c.userId === f.userId &&
              c.status === f.status &&
              !c.isDelete &&
              c.items.length > 0,
          ),
        ),
      ),
      findOne: jest.fn(
        async (f: any) =>
          carts.find(
            (c) =>
              c.userId === f.userId &&
              c.storeId === f.storeId &&
              c.status === f.status,
          ) ?? null,
      ),
      updateOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateMany: jest.fn(),
    },
    productModel: {
      findOne: jest.fn(async (f: any) => products.get(f._id) ?? null),
      find: jest.fn(() => chain([])),
    },
    productVariantModel: {
      findOne: jest.fn(async (f: any) => variants.get(f._id) ?? null),
    },
    storeModel: {
      findOne: jest.fn((f: any) => chain(stores.get(f._id) ?? null)),
      find: jest.fn((f: any) =>
        chain([...stores.values()].filter((s) => f._id.$in.includes(s._id))),
      ),
      findById: jest.fn((id: string) => chain(stores.get(id) ?? null)),
    },
    sellerModel: { find: jest.fn(() => chain([])) },
    subscriptionPlanModel: { findOne: jest.fn(() => chain(null)) },
    addressModel: {
      findOne: jest.fn(() => ({
        ...Promise.resolve({ _id: 'addr1', isDefault: true }),
        sort: () =>
          Promise.resolve({ _id: 'addr1', isDefault: true, save: jest.fn() }),
        then: (r: any) =>
          Promise.resolve({ _id: 'addr1', isDefault: true }).then(r),
      })),
    },
    userModel: {
      findById: jest.fn(() => chain({ currencyPreference: 'PKR' })),
    },
    checkoutModel: {
      create: jest.fn(async (doc: any) => {
        const d = { _id: `co${created.length + 1}`, ...doc };
        created.push(d);
        return d;
      }),
    },
  };
  const fx = new ExchangeRateService({} as any, {} as any, {} as any);
  jest.spyOn(fx, 'buildSnapshots').mockImplementation(
    async (cs: string[]) =>
      [...new Set(cs)].map((currency) => ({
        currency,
        ratePerUSD: currency === 'USD' ? 1 : 280,
        effectiveFrom: new Date(),
        source: 'admin',
        exchangeRateId: null,
      })) as any,
  );
  const svc = new CheckoutService(
    { repositories: repos } as any,
    {
      getActiveBenefits: jest.fn().mockResolvedValue(null),
      resolveProductDiscount: jest.fn(),
    } as any,
    {
      getActiveCampaignsForStores: jest.fn().mockResolvedValue(new Map()),
    } as any,
    { isManualPaymentEnabled: jest.fn().mockResolvedValue(false) } as any,
    fx,
    {} as any,
    {
      getActiveDiscountsForStores: jest.fn().mockResolvedValue(new Map()),
    } as any,
  );
  return { svc, repos, carts, created, userId };
}

const create = (w: ReturnType<typeof world>, body: any = {}) =>
  w.svc.createCheckout(w.userId, { currencyPreference: 'PKR', ...body });

describe("createCheckout — one checkout across all of the buyer's store carts", () => {
  it("without a storeId merges every store's cart; totals are converted per line into the checkout currency", async () => {
    const w = world([
      { storeId: 'A', productId: 'pa', price: 1000, currency: 'PKR', qty: 2 }, // PKR 2000
      { storeId: 'B', productId: 'pb', price: 10, currency: 'USD', qty: 3 }, //  USD 30 = PKR 8400
    ]);
    const { data } = await create(w);
    expect(data.checkout.items.map((i: any) => i.storeId).sort()).toEqual([
      'A',
      'B',
    ]);
    expect(data.checkout.subtotal).toBe(10400);
    expect(data.checkout.totalAmount).toBe(10400);
    expect(data.unavailableItems).toEqual([]);
  });

  it("REGRESSION: with a storeId it checks out only that store's cart, exactly as before", async () => {
    const w = world([
      { storeId: 'A', productId: 'pa', price: 1000, currency: 'PKR' },
      { storeId: 'B', productId: 'pb', price: 10, currency: 'USD' },
    ]);
    const { data } = await create(w, { storeId: 'A' });
    expect(data.checkout.items.map((i: any) => i.storeId)).toEqual(['A']);
    expect(data.checkout.subtotal).toBe(1000);
    expect(w.repos.cartModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', storeId: 'A' }),
    );
    expect(w.repos.cartModel.find).not.toHaveBeenCalled();
  });

  it('REGRESSION: with a storeId, an inactive store still fails the whole checkout (no silent skipping)', async () => {
    const w = world([
      { storeId: 'A', productId: 'pa', storeStatus: 'suspended' },
    ]);
    await expect(create(w, { storeId: 'A' })).rejects.toThrow(
      /store is not active/,
    );
  });

  it('the optional items selection works across stores', async () => {
    const w = world([
      { storeId: 'A', productId: 'pa1' },
      { storeId: 'A', productId: 'pa2' },
      { storeId: 'B', productId: 'pb1' },
    ]);
    const { data } = await create(w, {
      items: [
        { productId: 'pa2', variantId: 'v-pa2' },
        { productId: 'pb1', variantId: 'v-pb1' },
      ],
    });
    expect(data.checkout.items.map((i: any) => i.productId).sort()).toEqual([
      'pa2',
      'pb1',
    ]);
  });

  it("never includes another buyer's cart", async () => {
    const w = world([{ storeId: 'A', productId: 'pa' }]);
    w.carts.push({
      userId: 'someone-else',
      storeId: 'B',
      status: 'active',
      isDelete: false,
      items: [{ productId: 'px', productVariantId: 'v-px', quantity: 1 }],
    });
    const { data } = await create(w);
    expect(data.checkout.items.map((i: any) => i.storeId)).toEqual(['A']);
  });

  it('an empty marketplace cart is rejected', async () => {
    await expect(create(world([]))).rejects.toThrow(/Cart is empty/);
  });
});

describe('createCheckout — unavailable stores (D3) and limits (D4)', () => {
  it('skips lines of an inactive store, reports them, keeps them in the cart, and continues with the rest', async () => {
    const w = world([
      { storeId: 'A', productId: 'pa', price: 1000, currency: 'PKR' },
      { storeId: 'B', productId: 'pb', storeStatus: 'suspended' },
    ]);
    const { data } = await create(w);
    expect(data.checkout.items.map((i: any) => i.storeId)).toEqual(['A']);
    expect(data.unavailableItems).toEqual([
      expect.objectContaining({
        productId: 'pb',
        storeId: 'B',
        reason: 'store_inactive',
      }),
    ]);
    expect(w.carts.find((c) => c.storeId === 'B').items).toHaveLength(1); // not removed
    for (const fn of ['updateOne', 'findOneAndUpdate', 'updateMany'])
      expect(w.repos.cartModel[fn]).not.toHaveBeenCalled();
  });

  it('400s with the unavailable list when nothing is purchasable', async () => {
    const w = world([
      { storeId: 'B', productId: 'pb', storeStatus: 'pending' },
    ]);
    const err: any = await create(w).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().unavailableItems).toHaveLength(1);
    expect(w.repos.checkoutModel.create).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_CHECKOUT_LINES} lines`, async () => {
    const seeds: Seed[] = Array.from(
      { length: MAX_CHECKOUT_LINES + 1 },
      (_, i) => ({ storeId: `S${i % 5}`, productId: `p${i}` }),
    );
    await expect(create(world(seeds))).rejects.toThrow(/at most 100 items/);
  });

  it(`accepts exactly ${MAX_CHECKOUT_LINES} lines across ${MAX_CHECKOUT_STORES} stores`, async () => {
    const seeds: Seed[] = Array.from(
      { length: MAX_CHECKOUT_LINES },
      (_, i) => ({
        storeId: `S${i % MAX_CHECKOUT_STORES}`,
        productId: `p${i}`,
      }),
    );
    const { data } = await create(world(seeds));
    expect(data.checkout.items).toHaveLength(MAX_CHECKOUT_LINES);
  });

  it(`rejects more than ${MAX_CHECKOUT_STORES} stores`, async () => {
    const seeds: Seed[] = Array.from(
      { length: MAX_CHECKOUT_STORES + 1 },
      (_, i) => ({ storeId: `S${i}`, productId: `p${i}` }),
    );
    await expect(create(world(seeds))).rejects.toThrow(/at most 20 stores/);
  });
});

describe('createCheckout — Cash on Delivery only for single-store physical carts (D2a)', () => {
  const methods = async (seeds: Seed[]) =>
    (await create(world(seeds))).data.allowedPaymentMethods as string[];

  it('offers COD when all physical items come from one store', async () => {
    expect(
      await methods([
        { storeId: 'A', productId: 'p1', type: 'physical' },
        { storeId: 'A', productId: 'p2', type: 'physical' },
      ]),
    ).toContain('cash_on_delivery');
  });

  it('omits COD when physical items come from two stores', async () => {
    const m = await methods([
      { storeId: 'A', productId: 'p1', type: 'physical' },
      { storeId: 'B', productId: 'p2', type: 'physical' },
    ]);
    expect(m).not.toContain('cash_on_delivery');
    expect(m).toContain('stripe');
  });

  it("omits 'split' (digital online + physical COD) when the physical items span two stores, but not for one", async () => {
    const two = await methods([
      { storeId: 'A', productId: 'p1', type: 'physical' },
      { storeId: 'B', productId: 'p2', type: 'physical' },
      { storeId: 'C', productId: 'p3', type: 'digital' },
    ]);
    expect(two).not.toContain('split');
    const one = await methods([
      { storeId: 'A', productId: 'p1', type: 'physical' },
      { storeId: 'C', productId: 'p3', type: 'digital' },
    ]);
    expect(one).toContain('split');
  });

  it('digital items from many stores do not affect COD eligibility (digital is never COD anyway)', async () => {
    const m = await methods([
      { storeId: 'A', productId: 'p1', type: 'physical' },
      { storeId: 'B', productId: 'p2', type: 'digital' },
      { storeId: 'C', productId: 'p3', type: 'digital' },
    ]);
    expect(m).toContain('split');
  });
});

describe('createCheckout — free checkout is offered only when the total is exactly 0', () => {
  const methods = async (seeds: Seed[]) =>
    (await create(world(seeds))).data.allowedPaymentMethods as string[];
  it('a cart of free items offers only the free confirmation', async () => {
    expect(
      await methods([
        { storeId: 'A', productId: 'p1', price: 0 },
        { storeId: 'B', productId: 'p2', price: 0 },
      ]),
    ).toEqual(['free']);
  });
  it('a paid cart never offers it', async () => {
    expect(
      await methods([
        { storeId: 'A', productId: 'p1', price: 0 },
        { storeId: 'B', productId: 'p2', price: 10 },
      ]),
    ).not.toContain('free');
  });
});

describe('createCheckout — concurrency', () => {
  it('two simultaneous calls make two independent checkouts and place no order; the carts are untouched', async () => {
    const w = world([
      { storeId: 'A', productId: 'pa' },
      { storeId: 'B', productId: 'pb' },
    ]);
    const [first, second] = await Promise.all([create(w), create(w)]);
    expect(first.data.checkout._id).not.toBe(second.data.checkout._id);
    expect(w.created).toHaveLength(2);
    expect(w.carts.every((c) => c.items.length === 1)).toBe(true);
    for (const fn of ['updateOne', 'findOneAndUpdate', 'updateMany'])
      expect(w.repos.cartModel[fn]).not.toHaveBeenCalled();
  });

  it('a cart edited after the checkout was created does not change that checkout (it is a priced snapshot)', async () => {
    const w = world([{ storeId: 'A', productId: 'pa', price: 10, qty: 1 }]);
    const { data } = await create(w);
    w.carts[0].items[0].quantity = 9; // the buyer keeps editing the cart
    expect(data.checkout.items[0].quantity).toBe(1);
    expect(data.checkout.subtotal).toBe(2800); // USD 10 at 280, frozen
  });
});
