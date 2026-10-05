import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { AdminUpdateMessagingReportDto } from './dto/admin-update-report.dto';

const OID = (n: number) => `64f0c0ffee0c0ffee0c0ff${String(n).padStart(2, '0')}`;
const BUYER = OID(1), SELLER = OID(2), STORE = OID(4), REPORT = OID(9);
const chain = (v: any) => {
  const q: any = {};
  for (const k of ['sort', 'skip', 'limit', 'select']) q[k] = jest.fn(() => q);
  q.lean = jest.fn().mockResolvedValue(v);
  return q;
};

function build(over: { convs?: any[]; reports?: any[]; updated?: any; exists?: any } = {}) {
  const convModel: any = {
    find: jest.fn(() => chain(over.convs ?? [])),
    countDocuments: jest.fn().mockResolvedValue((over.convs ?? []).length),
  };
  const rptModel: any = {
    find: jest.fn(() => chain(over.reports ?? [])),
    countDocuments: jest.fn().mockResolvedValue((over.reports ?? []).length),
    findOneAndUpdate: jest.fn(() => chain(over.updated ?? null)),
    exists: jest.fn().mockResolvedValue(over.exists ?? null),
  };
  const repos: any = {
    conversationModel: convModel, reportModel: rptModel, messageModel: {}, blockModel: {},
    storeModel: { find: jest.fn(() => chain([{ _id: STORE, name: 'Noor Books' }])) },
    userModel: { find: jest.fn(() => chain([{ _id: BUYER, name: 'Aisha', email: 'a@x.io' }])) },
    sellerModel: { find: jest.fn(() => chain([{ _id: SELLER, name: 'Bilal' }])) },
  };
  const svc = new MessagingService({ repositories: repos } as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, convModel, rptModel };
}

describe('MessagingService — admin list enrichment', () => {
  it('attaches store, buyer and seller names to conversations', async () => {
    const { svc } = build({ convs: [{ _id: OID(3), storeId: STORE, buyerId: BUYER, sellerId: SELLER }] });
    const res: any = await svc.adminGetConversations({});
    expect(res.conversations[0]).toEqual(expect.objectContaining({ storeName: 'Noor Books', buyerName: 'Aisha', buyerEmail: 'a@x.io', sellerName: 'Bilal' }));
  });

  it('rejects non-ObjectId / operator-shaped id filters', async () => {
    const { svc, convModel } = build();
    await expect(svc.adminGetConversations({ storeId: { $ne: 1 } })).rejects.toThrow(BadRequestException);
    await expect(svc.adminGetConversations({ buyerId: 'nope' })).rejects.toThrow(BadRequestException);
    expect(convModel.find).not.toHaveBeenCalled();
  });

  it('attaches reporter and reported-user names to reports', async () => {
    const { svc } = build({ reports: [{ _id: REPORT, reporterId: BUYER, targetType: 'user', targetId: SELLER }] });
    const res: any = await svc.adminGetReports({});
    expect(res.reports[0]).toEqual(expect.objectContaining({ reporterName: 'Aisha', targetName: 'Bilal' }));
  });
});

describe('MessagingService.adminUpdateReport', () => {
  it('validates the body', async () => {
    const errs = async (body: object) => (await validate(plainToInstance(AdminUpdateMessagingReportDto, body))).map((e) => e.property);
    expect(await errs({ status: 'deleted' })).toContain('status');
    expect(await errs({ status: 'resolved', adminNotes: 'x'.repeat(1001) })).toContain('adminNotes');
    expect(await errs({ status: 'reviewed' })).toEqual([]);
  });

  it('resolves only an open messaging report and stamps the admin + time', async () => {
    const { svc, rptModel } = build({ updated: { _id: REPORT, status: 'resolved' } });
    await svc.adminUpdateReport(REPORT, { status: 'resolved', adminNotes: ' warned ' }, 'admin-1');
    const [filter, update] = rptModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: REPORT, targetType: { $in: ['user', 'message', 'conversation'] }, status: { $ne: 'resolved' } });
    expect(update.$set).toEqual(expect.objectContaining({ status: 'resolved', reviewedBy: 'admin-1', adminNotes: 'warned', resolvedAt: expect.any(Date) }));
  });

  it('404 for an unknown report, 409 for an already-resolved one, 400 for a bad id', async () => {
    await expect(build().svc.adminUpdateReport(REPORT, { status: 'reviewed' }, 'a')).rejects.toThrow(NotFoundException);
    await expect(build({ exists: { _id: REPORT } }).svc.adminUpdateReport(REPORT, { status: 'reviewed' }, 'a')).rejects.toThrow(ConflictException);
    await expect(build().svc.adminUpdateReport('bad', { status: 'reviewed' }, 'a')).rejects.toThrow(BadRequestException);
  });
});
