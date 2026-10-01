/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CartService } from './cart.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const STORE_A = '64f0c0ffee0c0ffee0c0ff0a'; // PKR store
const STORE_B = '64f0c0ffee0c0ffee0c0ff0b'; // USD store
const PROD_A = '64f0c0ffee0c0ffee0c0fa01';
const VAR_A = '64f0c0ffee0c0ffee0c0fa02';
const PROD_B = '64f0c0ffee0c0ffee0c0fb01';
const VAR_B = '64f0c0ffee0c0ffee0c0fb02';

const chain = (v: any) => {
  const c: any = {
    select: () => c,
    sort: () => c,
    limit: () => c,
    lean: () => Promise.resolve(v),
    then: (res: any, rej: any) => Promise.resolve(v).then(res, rej),
  };
  return c;
};

const SNAPSHOTS = [
  {
    currency: 'PKR',
    ratePerUSD: 280,
    effectiveFrom: new Date(),
    source: 'test',
    exchangeRateId: null,
  },
  {
    currency: 'USD',
    ratePerUSD: 1,
    effectiveFrom: new Date(),
    source: 'test',
    exchangeRateId: null,
  },
];

function makeSvc(
  over: {
    carts?: any[];
    stores?: any[];
    userPref?: string | null;
    fxFails?: boolean;
  } = {},
) {
  const carts = over.carts ?? [];
  const stores = over.stores ?? [
    {
      _id: STORE_A,
      name: 'Store A',
      slug: 'a',
      logo: 'a.png',
      status: 'active',
      baseCurrency: 'PKR',
    },
    {
      _id: STORE_B,
      name: 'Store B',
      slug: 'b',
      logo: null,
      status: 'active',
      baseCurrency: 'USD',
    },
  ];
  const repos: any = {
    cartModel: {
      find: jest.fn((filter: any) =>
        chain(
          carts.filter(
            (c) =>
              c.userId === filter.userId && !c.isDelete && c.items.length > 0,
          ),
        ),
      ),
      findOne: jest.fn(
        async (filter: any) =>
          carts.find(
            (c) =>
              c.userId === filter.userId &&
              c.storeId === filter.storeId &&
              !c.isDelete,
          ) ?? null,
      ),
      create: jest.fn(async (doc: any) => ({ ...doc, _id: 'newcart' })),
      updateMany: jest.fn(async (filter: any, update: any) => {
        let n = 0;
        for (const c of carts) {
          if (c.userId === filter.userId && !c.isDelete && c.items.length > 0) {
            c.items = update.$set.items;
            n++;
          }
        }
        return { modifiedCount: n };
      }),
    },
    productModel: {
      find: jest.fn(() => chain([])),
      findById: jest.fn(),
    },
    sellerModel: { find: jest.fn(() => chain([])) },
    storeModel: {
      find: jest.fn(() => chain(stores)),
      exists: jest.fn().mockResolvedValue(true),
    },
    productVariantModel: { findById: jest.fn() },
    userModel: {
      findById: jest.fn(() =>
        chain(
          over.userPref === undefined
            ? { currencyPreference: 'PKR' }
            : { currencyPreference: over.userPref },
        ),
      ),
    },
  };
  const fx = new ExchangeRateService({} as any, {} as any, {} as any);
  jest
    .spyOn(fx, 'buildSnapshots')
    .mockImplementation(async (currencies: string[]) => {
      if (over.fxFails && new Set(currencies).size > 1)
        throw new BadRequestException('stale rate');
      return SNAPSHOTS.filter((s) => currencies.includes(s.currency)) as any;
    });
  return {
    svc: new CartService({ repositories: repos } as any, fx),
    repos,
    carts,
  };
}

const cartOf = (userId: string, storeId: string, items: any[]) => ({
  userId,
  storeId,
  isDelete: false,
  items,
});
const line = (
  productId: string,
  variantId: string,
  price: number,
  quantity: number,
  currency: string | null,
) => ({
  productId,
  productVariantId: variantId,
  name: `Item ${productId.slice(-2)}`,
  quantity,
  price,
  currency,
  images: [],
  options: [],
});

describe('CartService.getUnifiedCart', () => {
  it('returns both stores in one flat list with per-store subtotals and a grand total in the display currency', async () => {
    const { svc } = makeSvc({
      carts: [
        cartOf('u1', STORE_A, [line(PROD_A, VAR_A, 1000, 2, 'PKR')]), // PKR 2000
        cartOf('u1', STORE_B, [line(PROD_B, VAR_B, 10, 3, 'USD')]), //  USD 30 = PKR 8400
      ],
    });
    const { data } = await svc.getUnifiedCart('u1', 'PKR');

    expect(data.displayCurrency).toBe('PKR');
    expect(data.items).toHaveLength(2);
    expect(data.items.map((i: any) => i.storeId).sort()).toEqual(
      [STORE_A, STORE_B].sort(),
    );
    expect(
      data.items.find((i: any) => i.storeId === STORE_B).store,
    ).toMatchObject({ name: 'Store B', isActive: true });
    const a = data.stores.find((s: any) => s.storeId === STORE_A);
    const b = data.stores.find((s: any) => s.storeId === STORE_B);
    expect(a.subtotal).toBe(2000);
    expect(b.subtotal).toBe(8400);
    expect(data.grandTotal).toBe(10400);
    expect(data.totalItems).toBe(5);
    expect(data.conversionAvailable).toBe(true);
  });

  it("never includes another user's carts", async () => {
    const { svc } = makeSvc({
      carts: [
        cartOf('u1', STORE_A, [line(PROD_A, VAR_A, 1000, 1, 'PKR')]),
        cartOf('u2', STORE_B, [line(PROD_B, VAR_B, 10, 1, 'USD')]),
      ],
    });
    const { data } = await svc.getUnifiedCart('u1', 'PKR');
    expect(data.items).toHaveLength(1);
    expect(data.items[0].storeId).toBe(STORE_A);
    expect(data.grandTotal).toBe(1000);
  });

  it('falls back to the store base currency for lines saved before cart items carried a currency', async () => {
    const { svc } = makeSvc({
      carts: [cartOf('u1', STORE_B, [line(PROD_B, VAR_B, 10, 1, null)])],
    });
    const { data } = await svc.getUnifiedCart('u1', 'PKR');
    expect(data.items[0].currency).toBe('USD');
    expect(data.grandTotal).toBe(2800);
  });

  it('uses the saved currency preference when none is requested, and rejects an unsupported one', async () => {
    const { svc } = makeSvc({
      userPref: 'USD',
      carts: [cartOf('u1', STORE_B, [line(PROD_B, VAR_B, 10, 1, 'USD')])],
    });
    expect((await svc.getUnifiedCart('u1')).data.displayCurrency).toBe('USD');
    await expect(svc.getUnifiedCart('u1', 'XXX')).rejects.toThrow(
      /Unsupported currency/,
    );
  });

  it('keeps the cart readable with null converted totals when exchange rates are unavailable', async () => {
    const { svc } = makeSvc({
      fxFails: true,
      carts: [
        cartOf('u1', STORE_A, [line(PROD_A, VAR_A, 1000, 1, 'PKR')]),
        cartOf('u1', STORE_B, [line(PROD_B, VAR_B, 10, 1, 'USD')]),
      ],
    });
    const { data } = await svc.getUnifiedCart('u1', 'PKR');
    expect(data.conversionAvailable).toBe(false);
    expect(data.grandTotal).toBeNull();
    expect(data.items).toHaveLength(2);
    expect(data.stores.find((s: any) => s.storeId === STORE_A).subtotal).toBe(
      1000,
    ); // same currency still exact
    expect(
      data.stores.find((s: any) => s.storeId === STORE_B).subtotal,
    ).toBeNull();
  });

  it('flags an inactive store and skips a deleted store', async () => {
    const { svc } = makeSvc({
      stores: [
        {
          _id: STORE_A,
          name: 'Store A',
          slug: 'a',
          logo: null,
          status: 'suspended',
          baseCurrency: 'PKR',
        },
      ],
      carts: [
        cartOf('u1', STORE_A, [line(PROD_A, VAR_A, 1000, 1, 'PKR')]),
        cartOf('u1', STORE_B, [line(PROD_B, VAR_B, 10, 1, 'USD')]),
      ],
    });
    const { data } = await svc.getUnifiedCart('u1', 'PKR');
    expect(data.items).toHaveLength(1);
    expect(data.stores[0].isActive).toBe(false);
  });

  it('returns an empty cart for a buyer with no carts', async () => {
    const { data } = await makeSvc().svc.getUnifiedCart('u1', 'PKR');
    expect(data).toMatchObject({
      items: [],
      stores: [],
      totalItems: 0,
      grandTotal: 0,
    });
  });

  it('leaves my-carts output shape unchanged (store block + cart fields)', async () => {
    const { svc } = makeSvc({
      carts: [cartOf('u1', STORE_A, [line(PROD_A, VAR_A, 1000, 1, 'PKR')])],
    });
    const { data } = await svc.getMyCarts('u1');
    expect(data).toHaveLength(1);
    expect(data[0].store).toEqual({
      storeId: STORE_A,
      name: 'Store A',
      slug: 'a',
      logo: 'a.png',
      isActive: true,
    });
    expect(data[0].totalPrice).toBe(1000);
  });
});

describe('CartService.clearAllCarts', () => {
  it("empties only the caller's carts across every store", async () => {
    const { svc, carts } = makeSvc({
      carts: [
        cartOf('u1', STORE_A, [line(PROD_A, VAR_A, 1, 1, 'PKR')]),
        cartOf('u1', STORE_B, [line(PROD_B, VAR_B, 1, 1, 'USD')]),
        cartOf('u2', STORE_A, [line(PROD_A, VAR_A, 1, 1, 'PKR')]),
      ],
    });
    const res = await svc.clearAllCarts('u1');
    expect(res.data.cartsCleared).toBe(2);
    expect(
      carts.filter((c) => c.userId === 'u1').every((c) => c.items.length === 0),
    ).toBe(true);
    expect(carts.find((c) => c.userId === 'u2')!.items).toHaveLength(1);
  });
});

describe('CartService.addToCart from the main marketplace (no storeId)', () => {
  function addSetup() {
    const ctx = makeSvc();
    ctx.repos.productModel.findById = jest.fn((id: string) =>
      chain(
        id === PROD_A
          ? {
              _id: PROD_A,
              storeId: STORE_A,
              name: 'A book',
              status: 'active',
              isDelete: false,
              images: [],
            }
          : {
              _id: PROD_B,
              storeId: STORE_B,
              name: 'B course',
              status: 'active',
              isDelete: false,
              images: [],
            },
      ),
    );
    ctx.repos.productVariantModel.findById = jest.fn((id: string) =>
      chain({
        _id: id,
        productId: id === VAR_A ? PROD_A : PROD_B,
        status: 'active',
        isDelete: false,
        price: 10,
        currency: 'USD',
        images: [],
        options: [],
      }),
    );
    return ctx;
  }

  it("files each item under its product's own store", async () => {
    const { svc, repos } = addSetup();
    await svc.addToCart('u1', undefined, {
      productId: PROD_A,
      productVariantId: VAR_A,
      quantity: 1,
    });
    await svc.addToCart('u1', undefined, {
      productId: PROD_B,
      productVariantId: VAR_B,
      quantity: 1,
    });
    const created = repos.cartModel.create.mock.calls.map(
      (c: any[]) => c[0].storeId,
    );
    expect(created).toEqual([STORE_A, STORE_B]);
  });

  it("rejects a storefront trying to add another store's product", async () => {
    const { svc } = addSetup();
    await expect(
      svc.addToCart('u1', STORE_A, {
        productId: PROD_B,
        productVariantId: VAR_B,
        quantity: 1,
      }),
    ).rejects.toThrow(/not sold by this store/);
  });
});
