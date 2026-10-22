/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy test */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminMarketingService } from './admin-marketing.service';

function make(existing: any) {
  const findByIdAndUpdate = jest.fn().mockImplementation((_f: any, upd: any) => Promise.resolve({ ...existing, ...upd.$set }));
  const svc: any = Object.create(AdminMarketingService.prototype);
  svc.databaseService = { repositories: { campaignModel: { findOneAndUpdate: findByIdAndUpdate, updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) } } };
  Object.defineProperty(svc, 'r', { get: () => svc.databaseService.repositories });
  svc.findCampaignOrThrow = jest.fn().mockResolvedValue(existing);
  svc.assertOrderAvailable = jest.fn().mockResolvedValue(undefined);
  svc.log = jest.fn();
  svc.announceCampaignLive = jest.fn();
  svc.announceCampaignEnded = jest.fn();
  return { svc, findByIdAndUpdate };
}
const base = { name: 'Sale', status: 'draft', order: 1, startDate: new Date(Date.now() - 1000), endDate: new Date(Date.now() + 86_400_000), discountType: null, discountValue: null };

describe('updateCampaign applies fields and status in ONE write', () => {
  it('saves name + status together and announces the go-live', async () => {
    const { svc, findByIdAndUpdate } = make(base);
    await svc.updateCampaign('c1', { name: 'New', status: 'active' }, {});
    expect(findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(findByIdAndUpdate.mock.calls[0][1].$set).toMatchObject({ name: 'New', status: 'active' });
    expect(svc.announceCampaignLive).toHaveBeenCalled();
  });

  it('an invalid activation writes nothing at all (no half-saved edit)', async () => {
    const { svc, findByIdAndUpdate } = make({ ...base, endDate: new Date(Date.now() - 1000) });
    await expect(svc.updateCampaign('c1', { name: 'New', status: 'active' }, {})).rejects.toThrow(BadRequestException);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('createCampaign default rotation position', () => {
  it('takes highest held slot + 1, not the campaign count', async () => {
    const create = jest.fn().mockImplementation((d: any) => Promise.resolve({ _id: 'n1', ...d }));
    const lean = jest.fn().mockResolvedValue({ order: 2 });
    const campaignModel: any = { create, findOne: jest.fn().mockImplementation((q: any) => (q && q.slug !== undefined ? Promise.resolve(null) : { sort: () => ({ select: () => ({ lean }) }) })) };
    const svc: any = Object.create(AdminMarketingService.prototype);
    svc.databaseService = { repositories: { campaignModel } };
    Object.defineProperty(svc, 'r', { get: () => svc.databaseService.repositories });
    svc.assertOrderAvailable = jest.fn();
    svc.log = jest.fn();
    const dto = { name: 'Eid', startDate: '2030-01-01T00:00:00Z', endDate: '2030-01-05T00:00:00Z' };
    await svc.createCampaign(dto, { adminId: 'a' });
    expect(create.mock.calls[0][0].order).toBe(3);
  });
});

describe('Phase 4/E: live campaign money terms are frozen', () => {
  const live = { ...base, status: 'active', discountType: 'percentage', discountValue: 10, sponsorType: 'seller' };

  it('rejects a discount value / type / sponsor change on a live campaign and writes nothing', async () => {
    for (const dto of [{ discountValue: 50 }, { discountType: 'fixed' }, { sponsorType: 'platform' }]) {
      const { svc, findByIdAndUpdate } = make(live);
      await expect(svc.updateCampaign('c1', dto, {})).rejects.toThrow(/cannot be changed once a campaign is live/);
      expect(findByIdAndUpdate).not.toHaveBeenCalled();
    }
  });

  it('still lets a live campaign change cosmetic fields, and accepts an unchanged resubmit of the money fields', async () => {
    const { svc, findByIdAndUpdate } = make(live);
    await svc.updateCampaign('c1', { name: 'Renamed', discountValue: 10, discountType: 'percentage', sponsorType: 'seller' }, {});
    expect(findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('allows the money terms on a draft and on a campaign that is scheduled for the future', async () => {
    const a = make({ ...base, status: 'draft' });
    await a.svc.updateCampaign('c1', { discountValue: 20, discountType: 'percentage' }, {});
    expect(a.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    const b = make({ ...live, startDate: new Date(Date.now() + 86_400_000), endDate: new Date(Date.now() + 3 * 86_400_000) });
    await b.svc.updateCampaign('c1', { discountValue: 20 }, {});
    expect(b.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('the write is conditional on the status that was validated (a concurrent change gives 409)', async () => {
    const { svc, findByIdAndUpdate } = make(base);
    await svc.updateCampaign('c1', { name: 'X' }, {});
    expect(findByIdAndUpdate.mock.calls[0][0]).toEqual({ _id: 'c1', isDelete: false, status: 'draft' });
    const lost = make(base);
    lost.findByIdAndUpdate.mockResolvedValueOnce(null);
    await expect(lost.svc.updateCampaign('c1', { name: 'X' }, {})).rejects.toThrow(ConflictException);
  });
});

describe('Phase 4/E: go-live announcement runs once', () => {
  it('claims liveNotifiedAt atomically; a second claim sends nothing', async () => {
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    const find = jest.fn();
    const svc: any = Object.create(AdminMarketingService.prototype);
    svc.databaseService = { repositories: { campaignModel: { updateOne }, storeModel: { find } } };
    Object.defineProperty(svc, 'r', { get: () => svc.databaseService.repositories });
    svc.notificationsService = { notify: jest.fn() };
    svc.logger = { error: jest.fn() };
    svc.announceCampaignLive({ _id: 'c1', name: 'Eid', startDate: new Date(), endDate: new Date() });
    await new Promise((r) => setImmediate(r));
    expect(updateOne).toHaveBeenCalledWith({ _id: 'c1', liveNotifiedAt: null }, { $set: { liveNotifiedAt: expect.any(Date) } });
    expect(find).not.toHaveBeenCalled();
    expect(svc.notificationsService.notify).not.toHaveBeenCalled();
  });

  it('does not even try when the campaign is already marked announced', () => {
    const updateOne = jest.fn();
    const svc: any = Object.create(AdminMarketingService.prototype);
    svc.databaseService = { repositories: { campaignModel: { updateOne } } };
    Object.defineProperty(svc, 'r', { get: () => svc.databaseService.repositories });
    svc.notificationsService = { notify: jest.fn() };
    svc.announceCampaignLive({ _id: 'c1', name: 'Eid', startDate: new Date(), endDate: new Date(), liveNotifiedAt: new Date() });
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('Phase 4/E: reactivation slot collision and platform coupon updates', () => {
  it('reactivating onto a taken rotation position explains what to do (409)', async () => {
    const svc: any = Object.create(AdminMarketingService.prototype);
    const campaign = { name: 'Old', status: 'ended', order: 0, endDate: new Date(Date.now() + 86_400_000) };
    svc.findCampaignOrThrow = jest.fn().mockResolvedValue(campaign);
    svc.assertOrderAvailable = jest.fn().mockRejectedValue(new ConflictException('Position 0 is already used by "Eid" — choose a different number.'));
    svc.databaseService = { repositories: { campaignModel: { findOneAndUpdate: jest.fn() } } };
    Object.defineProperty(svc, 'r', { get: () => svc.databaseService.repositories });
    await expect(svc.setCampaignStatus('c1', { status: 'active' }, {})).rejects.toThrow(/Position 0 is already used by "Eid"\. Open the campaign/);
    expect(svc.databaseService.repositories.campaignModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  function couponSvc(existing: any) {
    const findByIdAndUpdate = jest.fn().mockResolvedValue({ ...existing, code: 'X' });
    const svc: any = Object.create(AdminMarketingService.prototype);
    svc.databaseService = { repositories: { couponModel: { findByIdAndUpdate } } };
    Object.defineProperty(svc, 'r', { get: () => svc.databaseService.repositories });
    svc.findPlatformCouponOrThrow = jest.fn().mockResolvedValue(existing);
    svc.log = jest.fn();
    return { svc, findByIdAndUpdate };
  }
  const coupon = { discountType: 'percentage', discountValue: 10, usageCount: 5, usageLimit: 10 };

  it('usageLimit cannot drop below how often it was already used', async () => {
    const { svc, findByIdAndUpdate } = couponSvc(coupon);
    await expect(svc.updatePlatformCoupon('k1', { usageLimit: 3 }, {})).rejects.toThrow(/already used/);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
    await svc.updatePlatformCoupon('k1', { usageLimit: 5 }, {});
    expect(findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('expiresAt in the past is rejected, a future one is saved', async () => {
    const { svc, findByIdAndUpdate } = couponSvc(coupon);
    await expect(svc.updatePlatformCoupon('k1', { expiresAt: '2020-01-01T00:00:00Z' }, {})).rejects.toThrow(/future/);
    await expect(svc.updatePlatformCoupon('k1', { expiresAt: 'garbage' }, {})).rejects.toThrow(BadRequestException);
    await svc.updatePlatformCoupon('k1', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, {});
    expect(findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('a percentage coupon stays capped at 100 whatever value is sent', async () => {
    const { svc } = couponSvc(coupon);
    await expect(svc.updatePlatformCoupon('k1', { discountValue: 150 }, {})).rejects.toThrow(/exceed 100/);
  });
});