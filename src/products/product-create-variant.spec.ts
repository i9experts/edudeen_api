import { ProductsService } from './products.service';

// Regression: the seller UI caches `data.defaultVariant` from the create response to open the edit form.
// The physical create response used to omit it, so the form had no variant (price 0 / crash).
describe('ProductsService.addPhysicalProduct response', () => {
  it('returns the real default variant with the price the seller entered', async () => {
    const created: any[] = [];
    const svc: any = Object.create(ProductsService.prototype);
    svc.entitlementsService = { assertCanCreateProduct: jest.fn() };
    svc.marketingService = { resolveProductCampaignIds: jest.fn().mockResolvedValue([]) };
    svc.resolveSubCategoryId = jest.fn().mockResolvedValue(null);
    svc.databaseService = {
      repositories: {
        sellerModel: { findOne: jest.fn().mockResolvedValue({ _id: 's1' }) },
        storeModel: {
          findOne: jest.fn().mockResolvedValue({
            _id: 'st1', status: 'active', productTypes: ['physical_products'], categoryId: 'c1', baseCurrency: 'PKR',
          }),
        },
        productModel: {
          findOne: jest.fn().mockResolvedValue(null),
          exists: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(async (d: any) => ({ _id: { toString: () => 'p1' }, ...d })),
        },
        productVariantModel: {
          create: jest.fn().mockImplementation(async (d: any) => { created.push(d); return { _id: 'v' + created.length, ...d }; }),
        },
      },
    };

    const res = await svc.addPhysicalProduct('s1', {
      storeId: 'st1', name: 'Abacus', description: 'Counting frame',
      variants: [{ price: 1234, compareAtPrice: 1500, stock: 3, options: [] }],
    });

    expect(res.data.defaultVariant).toBeTruthy();
    expect(res.data.defaultVariant.price).toBe(1234);
    expect(res.data.defaultVariant.isDefault).toBe(true);
    expect(res.data.variants).toHaveLength(1);
  });
});
