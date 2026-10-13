/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { assertPremiumGap } from './premium-gap';
import { ProductVariantsService } from '../product-variants/product-variants.service';

const terms = (gap = 5) => ({ getTerms: jest.fn().mockResolvedValue({ platformEnabled: true, platformPercent: 5, sellerFeePercent: 5, minGapPercent: gap }) });
const store15 = { premiumDiscount: { enabled: true, percent: 15 } };

describe('assertPremiumGap (R3, product create / edit)', () => {
  it('premium 15 (store), normal sale 10% passes; 12% fails with the exact message (400)', async () => {
    await expect(assertPremiumGap(terms(), store15, null, [{ price: 90, compareAtPrice: 100 }])).resolves.toBeUndefined();
    const err: any = await assertPremiumGap(terms(), store15, null, [{ price: 88, compareAtPrice: 100 }]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Your normal sale is 12% but your Premium discount is 15%. Premium must be at least 5 points better - lower the sale to 10% or raise Premium to 17%.');
  });
  it('product override beats the store percent', async () => {
    await expect(assertPremiumGap(terms(), store15, 25, [{ price: 80, compareAtPrice: 100 }])).resolves.toBeUndefined(); // 20% sale, premium 25
    await expect(assertPremiumGap(terms(), store15, 10, [{ price: 90, compareAtPrice: 100 }])).rejects.toBeInstanceOf(BadRequestException);
  });
  it('only when a premium percent applies AND the product has a normal sale', async () => {
    const t = terms();
    await expect(assertPremiumGap(t, { premiumDiscount: null }, null, [{ price: 50, compareAtPrice: 100 }])).resolves.toBeUndefined(); // no premium
    await expect(assertPremiumGap(t, { premiumDiscount: { enabled: false, percent: 15 } }, null, [{ price: 50, compareAtPrice: 100 }])).resolves.toBeUndefined();
    await expect(assertPremiumGap(t, store15, null, [{ price: 100, compareAtPrice: null }])).resolves.toBeUndefined(); // no sale
    expect(t.getTerms).not.toHaveBeenCalled(); // nothing to check, no settings read
  });
  it('uses the admin gap setting (gap 2: 12% sale is fine with premium 15)', async () => {
    await expect(assertPremiumGap(terms(2), store15, null, [{ price: 88, compareAtPrice: 100 }])).resolves.toBeUndefined();
    await expect(assertPremiumGap(terms(2), store15, null, [{ price: 86, compareAtPrice: 100 }])).rejects.toThrow('lower the sale to 13%');
  });
  it('no premium module = never throws (non-premium deployments are unchanged)', async () => {
    await expect(assertPremiumGap(undefined, store15, null, [{ price: 10, compareAtPrice: 100 }])).resolves.toBeUndefined();
  });
  it('demo-style data (store premium 10, compare-at 950 vs 1200) does not crash and reports a normal violation message', async () => {
    const err: any = await assertPremiumGap(terms(), { premiumDiscount: { enabled: true, percent: 10 } }, null, [{ price: 950, compareAtPrice: 1200 }]).catch((e) => e);
    expect(err.message).toContain('Your normal sale is 20.8%');
  });
});

describe('physical variant create / edit enforce the rule', () => {
  function svc(premium: any) {
    const product = { _id: 'p1', storeId: 's1', sellerId: 'u1', type: 'physical', premiumDiscountPercent: null };
    const variant = { _id: 'v1', productId: 'p1', price: 100, compareAtPrice: null, isDefault: true, options: [] };
    const repos: any = {
      productModel: { findOne: jest.fn().mockResolvedValue(product) },
      storeModel: { findOne: jest.fn((f: any) => { const r: any = Promise.resolve({ _id: 's1', baseCurrency: 'PKR', ...store15 }); r.select = () => ({ lean: async () => ({ _id: 's1', ...store15 }) }); return r; }) },
      productVariantModel: {
        find: jest.fn(() => ({ lean: async () => [] })), findOne: jest.fn().mockResolvedValue(variant),
        create: jest.fn(async (d: any) => ({ _id: 'v2', ...d })), findById: jest.fn().mockResolvedValue(variant), findByIdAndUpdate: jest.fn().mockResolvedValue(variant),
      },
    };
    return { s: new ProductVariantsService({ repositories: repos } as any, premium), repos };
  }
  it('addVariant with a 12% sale under a 15% premium -> 400; a 10% sale is created', async () => {
    const { s, repos } = svc(terms());
    await expect(s.addVariant('u1', 'p1', { price: 88, compareAtPrice: 100, options: [] } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(repos.productVariantModel.create).not.toHaveBeenCalled();
    await expect(s.addVariant('u1', 'p1', { price: 90, compareAtPrice: 100, options: [] } as any)).resolves.toMatchObject({ success: true });
  });
  it('updateVariant: checks the new price/compare-at only, uses the current value for the field not sent; unrelated edits are never blocked', async () => {
    const { s, repos } = svc(terms());
    await expect(s.updateVariant('u1', 'p1', 'v1', { compareAtPrice: 120 } as any)).rejects.toBeInstanceOf(BadRequestException); // 100 vs 120 = 16.7% > 10
    await expect(s.updateVariant('u1', 'p1', 'v1', { stock: 5 } as any)).resolves.toMatchObject({ success: true });
    expect(repos.productVariantModel.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });
  it('without the premium module the variant service behaves exactly as before', async () => {
    const { s } = svc(undefined);
    await expect(s.addVariant('u1', 'p1', { price: 10, compareAtPrice: 100, options: [] } as any)).resolves.toMatchObject({ success: true });
  });
});
