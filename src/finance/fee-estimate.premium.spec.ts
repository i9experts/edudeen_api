/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/** App backend gap #5: fee-estimate can return earnings at the Premium member price, with recordSale's fee logic. */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FinanceService, feeItemsFor } from './finance.service';
import { applyPremiumToLine, termsFromSettings } from '../premium/premium.util';

const SELLER = '507f1f77bcf86cd799439011';
const STORE = '507f1f77bcf86cd799439033';
const PRODUCT = '507f1f77bcf86cd799439044';

function build(opts: { fees?: any; settings?: any; product?: any; store?: any } = {}) {
  const store = { _id: STORE, sellerId: SELLER, isDelete: false, baseCurrency: 'PKR', name: 'Noor', ...opts.store };
  const balance = { storeId: STORE, currency: 'PKR', availableBalance: 0, pendingBalance: 0 };
  const chain: any = { lean: jest.fn().mockResolvedValue([balance]) };
  for (const k of ['sort', 'skip', 'limit', 'select']) chain[k] = jest.fn().mockReturnValue(chain);
  const productModel = { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(opts.product ?? null) }) })) };
  const db: any = { repositories: {
    storeModel: { findById: jest.fn().mockResolvedValue(store) },
    sellerBalanceModel: { find: jest.fn().mockReturnValue(chain), findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(balance) }) },
    productModel,
  } };
  const admin: any = { getPlatformFees: jest.fn().mockResolvedValue(opts.fees ?? { digital: { mode: 'percentage', value: 10 }, physical: { mode: 'percentage', value: 8 } }) };
  const terms = termsFromSettings(opts.settings ?? { platformDiscount: { enabled: true, percent: 5 }, premiumSellerFeePercent: 7, minGapPercent: 5 });
  const premium: any = { getTerms: jest.fn().mockResolvedValue(terms) };
  const svc = new FinanceService(db, { log: jest.fn() } as any, { resolveRate: jest.fn() } as any, admin, { notify: jest.fn() } as any, {} as any, undefined, premium);
  return { svc, productModel, terms };
}

describe('fee-estimate at the Premium member price', () => {
  it('no premium input -> response unchanged (no premium key)', async () => {
    const est: any = await build().svc.estimatePlatformFee(SELLER, STORE, { price: 1000, type: 'digital' });
    expect(est).not.toHaveProperty('premium');
    expect(est.fee).toBe(100);
    expect(est.net).toBe(900);
  });

  it('premiumPercent: member price, credited sale value, premium fee and net', async () => {
    const est: any = await build().svc.estimatePlatformFee(SELLER, STORE, { price: 1000, type: 'digital', premiumPercent: '15' });
    // member pays 1000 x (1 - 15% - 5%) = 800; seller is credited 800 + 50 platform-funded = 850; fee 7% of 850.
    expect(est.premium).toEqual({
      memberPrice: 800, sellerPercent: 15, platformPercent: 5, memberDiscountPercent: 20, platformFunded: 50,
      saleValue: 850, feePercent: 7, fee: 59.5, net: 790.5,
    });
    // the normal-price numbers are untouched
    expect(est.fee).toBe(100);
    expect(est.net).toBe(900);
  });

  it('matches what recordSale charges on a real premium line (feeItemsFor + perTypePlatformFee)', async () => {
    const { svc, terms } = build();
    for (const price of [250, 1499.5, 12000]) {
      const est: any = await svc.estimatePlatformFee(SELLER, STORE, { price, type: 'physical', premiumPercent: 12 });
      const line: any = { type: 'physical', price, quantity: 1, totalPrice: price };
      applyPremiumToLine(line, { price }, 12, terms);
      const saleAmount = Math.round((line.totalPrice + line.premiumPlatformDiscountUSD) * 100) / 100;
      const real: any = await (svc as any).platformCommission(STORE, saleAmount, 'PKR', feeItemsFor({ items: [line] }));
      expect(est.premium.memberPrice).toBe(line.price);
      expect(est.premium.saleValue).toBe(saleAmount);
      expect(est.premium.fee).toBe(real.platformFee);
      expect(est.premium.net).toBe(Math.round((saleAmount - real.platformFee) * 100) / 100);
    }
  });

  it('platform offer off -> only the seller percent; fee on the member price', async () => {
    const est: any = await build({ settings: { platformDiscount: { enabled: false, percent: 5 }, premiumSellerFeePercent: 5 } })
      .svc.estimatePlatformFee(SELLER, STORE, { price: 1000, type: 'digital', premiumPercent: 10 });
    expect(est.premium).toMatchObject({ memberPrice: 900, platformPercent: 0, platformFunded: 0, saleValue: 900, fee: 45, net: 855 });
  });

  it('productId: reads the product override, else the store setting; opt-out -> premium null', async () => {
    const own: any = await build({ product: { premiumDiscountPercent: 20 } }).svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'digital', productId: PRODUCT });
    expect(own.premium.sellerPercent).toBe(20);
    const fromStore: any = await build({ product: {}, store: { premiumDiscount: { enabled: true, percent: 10 } } })
      .svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'digital', productId: PRODUCT });
    expect(fromStore.premium.sellerPercent).toBe(10);
    const optOut: any = await build({ product: { premiumOptOut: true } }).svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'digital', productId: PRODUCT });
    expect(optOut.premium).toBeNull();
  });

  it('validation: percent 1-50, a real product of this store', async () => {
    const { svc } = build();
    for (const bad of ['0', '51', 'abc', -5]) {
      await expect(svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'digital', premiumPercent: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'digital', productId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'digital', productId: PRODUCT })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('platform fees not set: normal fee is null (not_set) but the premium block is still sent', async () => {
    const { svc } = build({ fees: null as any });
    (svc as any).adminConfigService.getPlatformFees = jest.fn().mockResolvedValue(null);
    const est: any = await svc.estimatePlatformFee(SELLER, STORE, { price: 1000, type: 'digital', premiumPercent: 10 });
    expect(est.fee).toBeNull();
    expect(est.reason).toBe('not_set');
    // 1000 x (1 - 10% - 5%) = 850 + 50 platform-funded = 900; premium fee 7% of 900.
    expect(est.premium).toMatchObject({ memberPrice: 850, saleValue: 900, fee: 63, net: 837 });
  });
});
