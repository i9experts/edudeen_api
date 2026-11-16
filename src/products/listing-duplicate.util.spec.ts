/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { titleKey, titlesSimilar, samePrice, duplicateWarning } from './listing-duplicate.util';
import { listingReviewReasons, applyNeedsReview, productWarnings } from './product-quality.util';
import { isRailEligible } from './home-rail.util';
import { ProductsService } from './products.service';

const chain = (v: any) => { const c: any = { select: () => c, sort: () => c, skip: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };

describe('title similarity', () => {
  it('ignores case, punctuation and spacing; near-identical word sets match', () => {
    expect(titleKey('Class 5 - Maths Workbook!')).toBe('class 5 maths workbook');
    expect(titlesSimilar('Class 5 Maths Workbook', 'class 5 - maths   workbook')).toBe(true);
    expect(titlesSimilar('Class 5 Complete Maths Workbook Set Oxford', 'Class 5 Complete Maths Workbook Set Oxford Press')).toBe(true);
  });
  it('different products do not match; very short titles only match when identical', () => {
    expect(titlesSimilar('Class 5 Maths Workbook', 'Class 6 Science Workbook')).toBe(false);
    expect(titlesSimilar('Maths Book', 'Maths Book 2')).toBe(false);
    expect(titlesSimilar('Maths Book', 'maths book')).toBe(true);
    expect(titlesSimilar('', 'x')).toBe(false);
  });
  it('same price within half a paisa', () => {
    expect(samePrice(500, 500)).toBe(true);
    expect(samePrice(500, 500.004)).toBe(true);
    expect(samePrice(500, 450)).toBe(false);
  });
});

describe('duplicate listing = non-blocking warning + needs_review reason', () => {
  it('adds the sentence to the warnings and the review reasons, and flags the listing', () => {
    const base = { title: 'Class 5 Complete Maths Workbook', type: 'digital', imageCount: 3, classFrom: 'class-5', classTo: 'class-5' };
    expect(listingReviewReasons(base)).toEqual([]);
    const reasons = listingReviewReasons({ ...base, duplicateOf: 'Class 5 Complete Maths Workbook' });
    expect(reasons).toEqual([duplicateWarning('Class 5 Complete Maths Workbook')]);
    expect(applyNeedsReview([], reasons).flagged).toBe(true);
    expect(productWarnings(base.title, 'class-5', 'class-5', { type: 'digital', imageCount: 3, duplicateOf: 'X Y Z' })).toHaveLength(1);
  });
});

describe('ProductsService.findDuplicateListing', () => {
  function make(rows: any[], variants: any[]) {
    const svc: any = Object.create(ProductsService.prototype);
    const productModel: any = { find: jest.fn(() => chain(rows)) };
    svc.databaseService = { repositories: { productModel, productVariantModel: { find: jest.fn(() => chain(variants)) } } };
    return { svc, productModel };
  }
  it('same store + very similar title + same price = the other product name; scoped to the store and excludes itself', async () => {
    const { svc, productModel } = make([{ _id: 'p1', name: 'Class 5 Maths Workbook' }], [{ productId: 'p1', price: 500 }]);
    expect(await svc.findDuplicateListing('store1', 'class 5 maths workbook', 500, 'me')).toBe('Class 5 Maths Workbook');
    const q = productModel.find.mock.calls[0][0];
    expect(q).toMatchObject({ storeId: 'store1', isDelete: false, _id: { $ne: 'me' } });
  });
  it('different price, different title, or a failed lookup = no duplicate (never throws)', async () => {
    expect(await make([{ _id: 'p1', name: 'Class 5 Maths Workbook' }], [{ productId: 'p1', price: 450 }]).svc.findDuplicateListing('s', 'Class 5 Maths Workbook', 500)).toBeNull();
    expect(await make([{ _id: 'p1', name: 'Class 6 Science Workbook' }], [{ productId: 'p1', price: 500 }]).svc.findDuplicateListing('s', 'Class 5 Maths Workbook', 500)).toBeNull();
    const { svc } = make([], []);
    svc.databaseService.repositories.productModel.find = () => { throw new Error('db down'); };
    expect(await svc.findDuplicateListing('s', 'Class 5 Maths Workbook', 500)).toBeNull();
    expect(await svc.findDuplicateListing('s', 'Class 5 Maths Workbook', NaN)).toBeNull();
  });
});

describe('isRailEligible', () => {
  it('needs a valid price and no needsReview', () => {
    const p = (extra = {}) => ({ variants: [{ isDefault: true, price: 10 }], ...extra });
    expect(isRailEligible(p())).toBe(true);
    expect(isRailEligible(p({ needsReview: true }))).toBe(false);
  });
});
