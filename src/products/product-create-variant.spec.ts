import { ProductsService } from './products.service';

function makeSvc(created: any[] = []) {
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
  return svc;
}

const body = (variant: any, extra: any = {}) => ({
  storeId: 'st1', name: 'Abacus', description: 'A wooden counting frame for learning numbers',
  variants: [{ price: 1234, compareAtPrice: 1500, stock: 3, shippingWeight: '600 g', options: [], ...variant }], ...extra,
});

// Regression: the seller UI caches `data.defaultVariant` from the create response to open the edit form.
// The physical create response used to omit it, so the form had no variant (price 0 / crash).
describe('ProductsService.addPhysicalProduct response', () => {
  it('returns the real default variant with the price the seller entered', async () => {
    const created: any[] = [];
    const res = await makeSvc(created).addPhysicalProduct('s1', body({}));
    expect(res.data.defaultVariant).toBeTruthy();
    expect(res.data.defaultVariant.price).toBe(1234);
    expect(res.data.defaultVariant.isDefault).toBe(true);
    expect(res.data.variants).toHaveLength(1);
    expect(created[0].shippingWeight).toBe('0.6 kg'); // normalized to kilograms
  });
});

describe('ProductsService.addPhysicalProduct validation', () => {
  const reject = async (variant: any, extra: any, re: RegExp) => {
    const svc = makeSvc();
    await expect(svc.addPhysicalProduct('s1', body(variant, extra))).rejects.toThrow(re);
    expect(svc.databaseService.repositories.productModel.create).not.toHaveBeenCalled();
  };
  it('rejects a missing or blank shipping weight', async () => {
    await reject({ shippingWeight: undefined }, {}, /Shipping weight is required/);
    await reject({ shippingWeight: '  ' }, {}, /Shipping weight is required/);
  });
  it('rejects a weight that is not a number, zero, or over 50 kg', async () => {
    await reject({ shippingWeight: 'abc' }, {}, /must be a number/);
    await reject({ shippingWeight: '0 kg' }, {}, /Minimum weight is 1 g/);
    await reject({ shippingWeight: '0.4 g' }, {}, /Minimum weight is 1 g/);
    await reject({ shippingWeight: '-5 kg' }, {}, /can't be negative/);
    await reject({ shippingWeight: '51 kg' }, {}, /more than 50 kg/);
    await reject({ shippingWeight: '60000 g' }, {}, /more than 50 kg/);
    await makeSvc().addPhysicalProduct('s1', body({ shippingWeight: '1 g' }));
    const created: any[] = []; await makeSvc(created).addPhysicalProduct('s1', body({ shippingWeight: '500g' })); expect(created[0].shippingWeight).toBe('0.5 kg');
  });
  it('rejects bad stock: negative, decimal, huge', async () => {
    await reject({ stock: -1 }, {}, /Stock can't be negative/);
    await reject({ stock: 2.5 }, {}, /whole number/);
    await reject({ stock: 100001 }, {}, /more than 100,000/);
  });
  it('accepts unlimited stock without a quantity, and stock 0', async () => {
    const created: any[] = [];
    await makeSvc(created).addPhysicalProduct('s1', body({ stock: undefined, unlimitedStock: true }));
    await makeSvc(created).addPhysicalProduct('s1', body({ stock: 0 }));
    expect(created).toHaveLength(2);
  });
  it('rejects a short description, compare-at <= price, PKR decimals', async () => {
    await reject({}, { description: 'Too short' }, /at least 20 characters/);
    await reject({ compareAtPrice: 1234 }, {}, /Compare-at must be higher than price/);
    await reject({ price: 450.75, compareAtPrice: null }, {}, /whole rupees/);
  });
});
