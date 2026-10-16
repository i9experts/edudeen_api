/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { ProductsService } from './products.service';

const chain = (v: any) => { const c: any = { select: () => c, sort: () => c, skip: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };
const NOT_TEST = { $ne: true };

function make(over: Record<string, any> = {}) {
  const productModel: any = {
    find: jest.fn(() => chain([])),
    findOne: jest.fn(() => chain(null)),
    ...over,
  };
  const svc: any = Object.create(ProductsService.prototype);
  svc.databaseService = {
    repositories: {
      productModel,
      storeModel: { exists: jest.fn().mockResolvedValue(true), find: jest.fn(() => chain([{ _id: 's1' }])) },
      productVariantModel: { find: jest.fn(() => chain([])) },
      sellerModel: { findOne: jest.fn(() => chain(null)) },
    },
  };
  svc.premiumService = { getEntitlements: jest.fn().mockResolvedValue({ isPremium: false }) };
  svc.isHiddenByEarlyAccess = jest.fn().mockResolvedValue(false);
  return { svc, productModel };
}

describe('isTest products are hidden from every public product query', () => {
  it('direct product page: the public never finds a test product (by slug or id)', async () => {
    const { svc, productModel } = make();
    const res = await svc.getProductById('507f1f77bcf86cd799439011', null, null);
    expect(res.success).toBe(false);
    for (const call of productModel.findOne.mock.calls) expect(call[0].isTest).toEqual(NOT_TEST);
  });

  it('direct product page: a signed-in buyer or seller is treated like the public', async () => {
    const { svc, productModel } = make();
    await svc.getProductById('some-slug', 'user1', 'buyer');
    expect(productModel.findOne.mock.calls[0][0].isTest).toEqual(NOT_TEST);
  });

  it('direct product page: an admin can still open a test product', async () => {
    const { svc, productModel } = make();
    await svc.getProductById('some-slug', 'admin1', 'admin');
    expect(productModel.findOne.mock.calls[0][0].isTest).toBeUndefined();
  });

  it('id-list paths (recently viewed, wishlist share, compare, shelves) exclude test products', async () => {
    const { svc, productModel } = make();
    svc.restrictToActiveStores = jest.fn(async () => undefined);
    svc.attachVariantsAndPricing = jest.fn(async (d: any[]) => d);
    await svc.getShapedProductsByIds(['507f1f77bcf86cd799439011'], null);
    expect(productModel.find.mock.calls[0][0].isTest).toEqual(NOT_TEST);
  });

  it('store rails (new arrivals) and premium deals exclude test products', async () => {
    const { svc, productModel } = make();
    svc.attachVariantsAndPricing = jest.fn(async (d: any[]) => d);
    await svc.getNewArrivals('507f1f77bcf86cd799439012', 5, null);
    expect(productModel.find.mock.calls[0][0].isTest).toEqual(NOT_TEST);

    svc.premiumService.getEntitlements.mockResolvedValue({ isPremium: true });
    svc.premiumDealsPool = null;
    svc.databaseService.repositories.storeModel.find = jest.fn(() => chain([{ _id: 's1', premiumDiscount: { enabled: true } }]));
    productModel.find.mockClear();
    await svc.getPremiumDeals(5, 'u1');
    expect(productModel.find.mock.calls[0][0].isTest).toEqual(NOT_TEST);
  });
});
