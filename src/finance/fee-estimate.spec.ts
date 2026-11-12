/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FinanceService } from './finance.service';

const SELLER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439022';
const STORE = '507f1f77bcf86cd799439033';

function build(currency: string, fees: any) {
  const balance = { storeId: STORE, currency, availableBalance: 0, pendingBalance: 0 };
  const chain: any = { lean: jest.fn().mockResolvedValue([balance]) };
  for (const k of ['sort', 'skip', 'limit', 'select']) chain[k] = jest.fn().mockReturnValue(chain);
  const m = {
    storeModel: { findById: jest.fn().mockResolvedValue({ _id: STORE, sellerId: SELLER, isDelete: false, baseCurrency: currency, name: 'Noor' }) },
    balanceModel: { find: jest.fn().mockReturnValue(chain), findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(balance) }) },
  };
  const db: any = { repositories: { storeModel: m.storeModel, sellerBalanceModel: m.balanceModel, transactionModel: {}, payoutModel: {}, payoutMethodModel: {}, payoutScheduleModel: {}, sellerModel: {}, taxReportModel: {}, orderModel: {}, campaignModel: {}, saleCreditJobModel: {} } };
  const admin: any = { getPlatformFees: jest.fn().mockResolvedValue(fees) };
  const commission: any = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.1, source: 'x' }) };
  return new FinanceService(db, { log: jest.fn().mockResolvedValue(true) } as any, commission, admin, { notify: jest.fn() } as any, { transaction: jest.fn() } as any);
}

describe('FinanceService.estimatePlatformFee', () => {
  const prices = [250, 1499.5, 12000];

  it('percentage mode: endpoint result equals the backend fee function for 3 prices', async () => {
    const svc = build('PKR', { digital: { mode: 'percentage', value: 12.5 }, physical: { mode: 'percentage', value: 8 } });
    for (const type of ['digital', 'physical'] as const) {
      for (const price of prices) {
        const est: any = await svc.estimatePlatformFee(SELLER, STORE, { price, type });
        const real: any = await (svc as any).perTypePlatformFee(price, est.currency, [{ type, totalPrice: price, quantity: 1 }]);
        expect(est.fee).toBe(real.platformFee);
        expect(est.net).toBe(Math.round((price - real.platformFee) * 100) / 100);
        expect(est.reason).toBeNull();
      }
    }
  });

  it('fixed mode: endpoint result equals the backend fee function for 3 prices (USD store)', async () => {
    const svc = build('USD', { digital: { mode: 'fixed', value: 0.5 }, physical: { mode: 'fixed', value: 1.25 } });
    for (const price of [0.3, 20, 400]) {
      const est: any = await svc.estimatePlatformFee(SELLER, STORE, { price, type: 'physical' });
      const real: any = await (svc as any).perTypePlatformFee(price, 'USD', [{ type: 'physical', totalPrice: price, quantity: 1 }]);
      expect(est.fee).toBe(real.platformFee);
      expect(est.fee).toBeLessThanOrEqual(price); // never more than the sale
    }
  });

  it('fee not set for the type -> fee null (UI: "Set by Edudeen"), never a made-up number', async () => {
    const none: any = await build('PKR', null).estimatePlatformFee(SELLER, STORE, { price: 1000, type: 'digital' });
    expect(none.fee).toBeNull(); expect(none.reason).toBe('not_set');
    const half: any = await build('PKR', { digital: { mode: 'percentage', value: 10 } }).estimatePlatformFee(SELLER, STORE, { price: 1000, type: 'physical' });
    expect(half.fee).toBeNull();
  });

  it('owner-only and input validation', async () => {
    const svc = build('PKR', { digital: { mode: 'percentage', value: 10 } });
    await expect(svc.estimatePlatformFee(OTHER, STORE, { price: 100, type: 'digital' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.estimatePlatformFee(SELLER, STORE, { price: -1, type: 'digital' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.estimatePlatformFee(SELLER, STORE, { price: NaN, type: 'digital' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.estimatePlatformFee(SELLER, STORE, { price: 100, type: 'course' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
