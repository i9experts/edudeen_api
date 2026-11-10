import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProductBulkService, computeNewPrice, normaliseIds } from './product-bulk.service';

const oid = (n: number) => n.toString(16).padStart(24, '0');
const SELLER = oid(900);
const STORE = oid(800);

function build(opts: { products: any[]; variants: any[]; premium?: any; planBlock?: boolean }) {
  const productBulkWrite = jest.fn().mockResolvedValue({ modifiedCount: opts.products.length });
  const variantBulkWrite = jest.fn().mockResolvedValue({});
  const log = jest.fn().mockResolvedValue(true);
  const lean = (rows: any[]) => ({ lean: async () => rows, select: () => ({ lean: async () => rows }) });
  const db: any = {
    repositories: {
      productModel: { find: jest.fn((q: any) => lean(opts.products.filter((p) => q._id.$in.includes(String(p._id)) && !p.isDelete))), bulkWrite: productBulkWrite },
      productVariantModel: { find: jest.fn(() => lean(opts.variants)), bulkWrite: variantBulkWrite },
      storeModel: { find: jest.fn(() => lean([{ _id: STORE, baseCurrency: 'PKR', premiumDiscount: null }])) },
    },
  };
  const entitlements: any = { assertCanCreateProduct: jest.fn(async () => { if (opts.planBlock) throw new Error('Plan ended'); }) };
  const svc = new ProductBulkService(db, { log } as any, entitlements, opts.premium);
  return { svc, productBulkWrite, variantBulkWrite, log };
}

const product = (n: number, extra: any = {}) => ({ _id: oid(n), sellerId: SELLER, storeId: STORE, name: `P${n}`, status: 'active', approvedAt: new Date(), isDelete: false, ...extra });
const variant = (n: number, price: number, extra: any = {}) => ({ _id: oid(n + 1000), productId: oid(n), price, compareAtPrice: null, ...extra });

describe('pure helpers', () => {
  it('rounds PKR to whole rupees and others to 2 decimals', () => {
    expect(computeNewPrice(999, 'percent', 10, 'PKR')).toBe(1099);
    expect(computeNewPrice(10, 'percent', -15, 'USD')).toBe(8.5);
    expect(computeNewPrice(10, 'set', 12.345, 'USD')).toBe(12.35);
  });
  it('validates ids', () => {
    expect(() => normaliseIds([])).toThrow(BadRequestException);
    expect(() => normaliseIds(['x'])).toThrow(BadRequestException);
    expect(() => normaliseIds(Array.from({ length: 101 }, (_, i) => oid(i + 1)))).toThrow(BadRequestException);
  });
});

describe('bulkSetStatus', () => {
  it('deactivates 3 products and audits once', async () => {
    const products = [product(1), product(2), product(3)];
    const { svc, productBulkWrite, log } = build({ products, variants: [] });
    const r: any = await svc.bulkSetStatus(SELLER, { ids: products.map((p) => String(p._id)), active: false });
    expect(r.data.updated).toHaveLength(3);
    expect(productBulkWrite.mock.calls[0][0]).toHaveLength(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].action).toBe('products_bulk_deactivated');
  });
  it('foreign id = 403 and nothing written', async () => {
    const products = [product(1), product(2, { sellerId: oid(777) })];
    const { svc, productBulkWrite, log } = build({ products, variants: [] });
    await expect(svc.bulkSetStatus(SELLER, { ids: [oid(1), oid(2)], active: false })).rejects.toThrow(ForbiddenException);
    expect(productBulkWrite).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it('skips plan-paused and contact-flagged goes to review; draft cannot deactivate', async () => {
    const products = [product(1, { status: 'inactive', pausedFromStatus: 'active' }), product(2, { status: 'inactive', flags: ['contact_info'] }), product(3, { status: 'draft' })];
    const { svc } = build({ products, variants: [] });
    const r: any = await svc.bulkSetStatus(SELLER, { ids: [oid(1), oid(2), oid(3)], active: true });
    expect(r.data.skipped.map((s: any) => s.id)).toEqual([oid(1), oid(3)]);
    expect(r.data.updated[0].status).toBe('pending_review');
  });
  it('plan ended blocks activation for every item', async () => {
    const { svc, productBulkWrite } = build({ products: [product(1, { status: 'inactive' })], variants: [], planBlock: true });
    const r: any = await svc.bulkSetStatus(SELLER, { ids: [oid(1)], active: true });
    expect(r.data.updated).toHaveLength(0);
    expect(r.data.skipped[0].reason).toBe('Plan ended');
    expect(productBulkWrite).not.toHaveBeenCalled();
  });
});

describe('bulkSetPrice', () => {
  it('dry run previews old -> new and writes nothing', async () => {
    const { svc, variantBulkWrite } = build({ products: [product(1), product(2)], variants: [variant(1, 1000), variant(2, 500)] });
    const r: any = await svc.bulkSetPrice(SELLER, { ids: [oid(1), oid(2)], mode: 'percent', value: 10, dryRun: true });
    expect(r.data.items.map((i: any) => [i.from, i.to])).toEqual([[1000, 1100], [500, 550]]);
    expect(r.data.canApply).toBe(true);
    expect(variantBulkWrite).not.toHaveBeenCalled();
  });
  it('applies in one bulkWrite and audits', async () => {
    const { svc, variantBulkWrite, log } = build({ products: [product(1), product(2)], variants: [variant(1, 1000), variant(2, 500)] });
    await svc.bulkSetPrice(SELLER, { ids: [oid(1), oid(2)], mode: 'set', value: 700 });
    expect(variantBulkWrite).toHaveBeenCalledTimes(1);
    expect(variantBulkWrite.mock.calls[0][0]).toHaveLength(2);
    expect(log.mock.calls[0][0].action).toBe('products_bulk_price_updated');
  });
  it('foreign id = 403, nothing changed', async () => {
    const { svc, variantBulkWrite } = build({ products: [product(1, { sellerId: oid(777) })], variants: [variant(1, 100)] });
    await expect(svc.bulkSetPrice(SELLER, { ids: [oid(1)], mode: 'set', value: 50 })).rejects.toThrow(ForbiddenException);
    expect(variantBulkWrite).not.toHaveBeenCalled();
  });
  it('one bad item (multi-variant) refuses the whole request and names it', async () => {
    const { svc, variantBulkWrite } = build({ products: [product(1), product(2)], variants: [variant(1, 100), variant(2, 100), variant(2, 200, { _id: oid(5000) })] });
    await expect(svc.bulkSetPrice(SELLER, { ids: [oid(1), oid(2)], mode: 'set', value: 150 })).rejects.toThrow(/"P2"/);
    expect(variantBulkWrite).not.toHaveBeenCalled();
  });
  it('free only when already free; compare-at must stay above price', async () => {
    const { svc } = build({ products: [product(1), product(2)], variants: [variant(1, 100), variant(2, 100, { compareAtPrice: 120 })] });
    const r: any = await svc.bulkSetPrice(SELLER, { ids: [oid(1), oid(2)], mode: 'set', value: 0, dryRun: true });
    expect(r.data.items[0].ok).toBe(false);
    const r2: any = await svc.bulkSetPrice(SELLER, { ids: [oid(2)], mode: 'set', value: 150, dryRun: true });
    expect(r2.data.items[0].reason).toMatch(/Compare-at/);
  });
  it('Premium gap breach refuses the request and names the product', async () => {
    const premium = { getTerms: async () => ({ minGapPercent: 5 }) };
    const { svc, variantBulkWrite } = build({ products: [product(1, { premiumDiscountPercent: 10 })], variants: [variant(1, 1000, { compareAtPrice: 1200 })], premium });
    // 1200 -> 1100 is an 8.3% sale; Premium 10% needs the sale <= 5%.
    await expect(svc.bulkSetPrice(SELLER, { ids: [oid(1)], mode: 'set', value: 1100 })).rejects.toThrow(/"P1".*Premium/);
    expect(variantBulkWrite).not.toHaveBeenCalled();
  });
});
