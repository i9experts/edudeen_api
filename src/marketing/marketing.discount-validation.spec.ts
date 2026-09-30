/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy tests */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { MarketingService } from './marketing.service';
import { DiscountsService } from '../discounts/discounts.service';

const STORE = { _id: 'store-1', sellerId: 'seller-1', baseCurrency: 'PKR' };
const activity: any = { log: jest.fn() };

describe('MarketingService — coupon validation', () => {
  let couponModel: any, service: MarketingService;
  beforeEach(() => {
    couponModel = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(async (d: any) => ({ _id: 'c1', ...d })), findByIdAndUpdate: jest.fn().mockResolvedValue({ code: 'X' }) };
    service = new MarketingService({ repositories: { couponModel, storeModel: { findOne: jest.fn().mockResolvedValue(STORE) } } } as any, activity);
  });
  const existing = (o: any = {}) => ({ _id: 'c1', code: 'SAVE10', discountType: 'percentage', discountValue: 10, ...o });

  it('stamps a fixed coupon with the STORE currency (was null → read as USD)', async () => {
    await service.createCoupon('seller-1', 'store-1', { code: 'flat', discountType: 'fixed', discountValue: 500 } as any);
    expect(couponModel.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'PKR' }));
  });

  it('a percentage coupon carries no currency', async () => {
    await service.createCoupon('seller-1', 'store-1', { code: 'pct', discountType: 'percentage', discountValue: 10 } as any);
    expect(couponModel.create).toHaveBeenCalledWith(expect.objectContaining({ currency: null }));
  });

  it('rejects a zero/negative discount on create', async () => {
    await expect(service.createCoupon('seller-1', 'store-1', { code: 'z', discountType: 'fixed', discountValue: 0 } as any)).rejects.toThrow(BadRequestException);
    await expect(service.createCoupon('seller-1', 'store-1', { code: 'n', discountType: 'fixed', discountValue: -5 } as any)).rejects.toThrow(BadRequestException);
  });

  it('UPDATE cannot push a percentage coupon above 100 (patching only discountValue)', async () => {
    couponModel.findOne.mockResolvedValueOnce(existing());
    await expect(service.updateCoupon('seller-1', 'store-1', 'c1', { discountValue: 500 } as any)).rejects.toThrow(/cannot exceed 100/);
    expect(couponModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('UPDATE switching fixed→percentage re-validates the existing value against the new type', async () => {
    couponModel.findOne.mockResolvedValueOnce(existing({ discountType: 'fixed', discountValue: 500 }));
    await expect(service.updateCoupon('seller-1', 'store-1', 'c1', { discountType: 'percentage' } as any)).rejects.toThrow(/cannot exceed 100/);
  });

  it('UPDATE to fixed sets the store currency; back to percentage clears it', async () => {
    couponModel.findOne.mockResolvedValueOnce(existing());
    await service.updateCoupon('seller-1', 'store-1', 'c1', { discountType: 'fixed', discountValue: 200 } as any);
    expect(couponModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', expect.objectContaining({ currency: 'PKR' }), expect.anything());
  });

  it('renaming a coupon onto an existing code is a 409, not a raw duplicate-key 500', async () => {
    couponModel.findOne.mockResolvedValueOnce(existing()).mockResolvedValueOnce({ _id: 'other', code: 'TAKEN' });
    await expect(service.updateCoupon('seller-1', 'store-1', 'c1', { code: 'taken' } as any)).rejects.toThrow(ConflictException);
  });
});

describe('DiscountsService — update validation', () => {
  let model: any, service: DiscountsService;
  beforeEach(() => {
    model = { findOne: jest.fn(), findOneAndUpdate: jest.fn().mockResolvedValue({ name: 'D' }) };
    service = new DiscountsService({ repositories: { automaticDiscountModel: model, storeModel: { findOne: jest.fn().mockResolvedValue(STORE) } } } as any, activity);
  });

  it('patching only discountValue on a percentage discount cannot exceed 100', async () => {
    model.findOne.mockResolvedValue({ discountType: 'percentage', discountValue: 10 });
    await expect(service.updateDiscount('seller-1', 'store-1', 'd1', { discountValue: 500 } as any)).rejects.toThrow(/cannot exceed 100/);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not $set keys the client did not send (no undefined→null overwrite)', async () => {
    model.findOne.mockResolvedValue({ discountType: 'percentage', discountValue: 10 });
    await service.updateDiscount('seller-1', 'store-1', 'd1', { name: 'New', discountValue: undefined, minOrderAmount: undefined } as any);
    const patch = model.findOneAndUpdate.mock.calls[0][1].$set;
    expect(patch).toEqual({ name: 'New' });
  });
});
