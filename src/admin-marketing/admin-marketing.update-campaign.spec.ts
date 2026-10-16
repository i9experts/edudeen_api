/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy test */
import { BadRequestException } from '@nestjs/common';
import { AdminMarketingService } from './admin-marketing.service';

function make(existing: any) {
  const findByIdAndUpdate = jest.fn().mockImplementation((_id: string, upd: any) => Promise.resolve({ ...existing, ...upd.$set }));
  const svc: any = Object.create(AdminMarketingService.prototype);
  svc.databaseService = { repositories: { campaignModel: { findByIdAndUpdate } } };
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
    const campaignModel: any = { create, findOne: jest.fn().mockReturnValue({ sort: () => ({ select: () => ({ lean }) }) }) };
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
