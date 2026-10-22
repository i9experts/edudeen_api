/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { PremiumService } from './premium.service';
import { UpdatePremiumSettingsDto } from './premium.dto';

const DAY = 86_400_000;
const lean = (v: any) => ({ lean: async () => v });
const PLAN = { _id: 'plan1', name: 'Premium', monthlyPriceUSD: 5, benefits: { monthlyCouponValue: 0 } };

function make(membershipModel: any) {
  const couponModel: any = { updateMany: jest.fn((..._a: any[]) => Promise.resolve({})), create: jest.fn() };
  const svc: any = Object.create(PremiumService.prototype);
  Object.assign(svc, {
    logger: { warn: jest.fn(), error: jest.fn() },
    db: { repositories: { couponModel } },
    membershipModel,
    entitlements: { invalidate: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    notifications: { notify: jest.fn().mockResolvedValue(undefined) },
  });
  svc.audit = jest.fn().mockResolvedValue(undefined);
  svc.notifyUser = jest.fn().mockResolvedValue(undefined);
  return { svc, couponModel };
}

describe('Phase 4/G: activate is a compare-and-set, not read-then-write', () => {
  it('the update is conditional on the exact membership that was read', async () => {
    const end = new Date(Date.now() + 10 * DAY);
    const existing = { _id: 'm1', status: 'active', currentPeriodEnd: end, startedAt: new Date('2026-01-01') };
    const findOneAndUpdate = jest.fn((..._a: any[]) => lean({ userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } }));
    const { svc } = make({ findOne: jest.fn(() => lean(existing)), findOneAndUpdate });
    await svc.activate('u1', PLAN, 'monthly', 'bank_transfer');
    expect(findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'm1', status: 'active', currentPeriodEnd: end });
  });

  it('when another approval changed it meanwhile, it re-reads and extends on top of THAT (no lost period)', async () => {
    const e1 = new Date(Date.now() + 10 * DAY);
    const e2 = new Date(e1.getTime() + 30 * DAY);
    const findOne = jest.fn()
      .mockReturnValueOnce(lean({ _id: 'm1', status: 'active', currentPeriodEnd: e1 }))
      .mockReturnValueOnce(lean({ _id: 'm1', status: 'active', currentPeriodEnd: e2 }));
    const findOneAndUpdate = jest.fn()
      .mockReturnValueOnce(lean(null)) // lost the race
      .mockReturnValueOnce(lean({ userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } }));
    const { svc } = make({ findOne, findOneAndUpdate });
    await svc.activate('u1', PLAN, 'monthly', 'bank_transfer');
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(findOneAndUpdate.mock.calls[1][0].currentPeriodEnd).toEqual(e2);
    expect(findOneAndUpdate.mock.calls[1][1].$set.currentPeriodEnd.getTime()).toBeGreaterThan(e2.getTime() + 27 * DAY);
  });

  it('two first-time activations racing on the unique userId: the loser retries instead of failing', async () => {
    const findOne = jest.fn().mockReturnValueOnce(lean(null)).mockReturnValueOnce(lean({ _id: 'm1', status: 'active', currentPeriodEnd: new Date(Date.now() + DAY) }));
    const findOneAndUpdate = jest.fn()
      .mockReturnValueOnce({ lean: async () => { throw Object.assign(new Error('dup'), { code: 11000 }); } })
      .mockReturnValueOnce(lean({ userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } }));
    const { svc } = make({ findOne, findOneAndUpdate });
    await expect(svc.activate('u1', PLAN, 'monthly', 'admin_grant')).resolves.toBeTruthy();
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('gives up with a clear 400 if it keeps losing', async () => {
    const { svc } = make({ findOne: jest.fn(() => lean({ _id: 'm1', status: 'active', currentPeriodEnd: new Date(Date.now() + DAY) })), findOneAndUpdate: jest.fn(() => lean(null)) });
    await expect(svc.activate('u1', PLAN, 'monthly', 'bank_transfer')).rejects.toThrow(BadRequestException);
  });

  it('re-activating switches the member\'s unused personal coupons back on', async () => {
    const { svc, couponModel } = make({ findOne: jest.fn(() => lean(null)), findOneAndUpdate: jest.fn(() => lean({ userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } })) });
    await svc.activate('u1', PLAN, 'monthly', 'admin_grant');
    expect(couponModel.updateMany).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'u1', platformFunded: true, isActive: false, usageCount: { $lt: 1 } }), { $set: { isActive: true } });
  });
});

describe('Phase 4/G: revoke / expiry also stop the member\'s coupons', () => {
  it('adminRevoke deactivates the unused personal platform-funded coupons', async () => {
    const { svc, couponModel } = make({ findOneAndUpdate: jest.fn(() => lean({ userId: '507f1f77bcf86cd799439011', status: 'cancelled' })) });
    await svc.adminRevoke('adm', '507f1f77bcf86cd799439011', 'abuse');
    expect(couponModel.updateMany).toHaveBeenCalledWith(
      { ownerUserId: '507f1f77bcf86cd799439011', platformFunded: true, isActive: true, usageCount: { $lt: 1 } },
      { $set: { isActive: false } },
    );
  });

  it('the lifecycle cron does the same for a membership that just expired', async () => {
    const find = jest.fn().mockReturnValueOnce({ limit: () => ({ lean: async () => [{ _id: 'm1', userId: 'u9', cancelAtPeriodEnd: false }] }) })
      .mockReturnValue({ limit: () => ({ lean: async () => [] }) });
    const { svc, couponModel } = make({ find, findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'm1' }) });
    await svc.runLifecycle(new Date());
    expect(couponModel.updateMany).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'u9' }), { $set: { isActive: false } });
  });
});

describe('Phase 4/G: premium settings use a real DTO', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const run = (body: any) => pipe.transform(body, { type: 'body', metatype: UpdatePremiumSettingsDto });

  it('accepts a valid partial body', async () => {
    const out: any = await run({ platformDiscount: { enabled: true, percent: 7.5 }, minGapPercent: 5 });
    expect(out.platformDiscount.percent).toBe(7.5);
  });
  it.each([
    [{ platformDiscount: { percent: 31 } }],
    [{ platformDiscount: { percent: -1 } }],
    [{ platformDiscount: { enabled: 'yes' } }],
    [{ premiumSellerFeePercent: 'abc' }],
    [{ premiumSellerFeePercent: 31 }],
    [{ minGapPercent: 51 }],
    [{ somethingElse: 1 }],
  ])('rejects %j before it reaches the service', async (body) => {
    await expect(run(body)).rejects.toThrow(BadRequestException);
  });
});