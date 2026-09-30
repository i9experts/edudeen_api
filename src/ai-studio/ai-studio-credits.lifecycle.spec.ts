/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { BadRequestException, HttpException } from '@nestjs/common';
import { AiStudioCreditsService } from './ai-studio-credits.service';
import { PublicWorksheetTrialController } from './public-worksheet-trial.controller';

function build() {
  const rows: any[] = [];
  const txnModel: any = {
    create: jest.fn().mockImplementation(async (d: any) => { const r = { _id: { toString: () => `t${rows.length + 1}` }, ...d }; rows.push(r); return r; }),
    updateOne: jest.fn().mockResolvedValue({}),
    deleteOne: jest.fn().mockResolvedValue({}),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
  };
  const aiCredits: any = { deduct: jest.fn().mockResolvedValue(undefined), grant: jest.fn().mockResolvedValue(undefined), getBalance: jest.fn().mockResolvedValue(0) };
  const svc = new AiStudioCreditsService({ repositories: { aiCreditTransactionModel: txnModel } } as any, aiCredits, { get: jest.fn() } as any);
  return { svc, txnModel, aiCredits, rows };
}

describe('AiStudioCreditsService — hold / refund / reaper', () => {
  it('records the hold BEFORE taking credits, then flags it deducted', async () => {
    const { svc, txnModel, aiCredits } = build();
    const order: string[] = [];
    txnModel.create.mockImplementation(async (d: any) => { order.push('create'); expect(d.deducted).toBe(false); return { _id: { toString: () => 't1' }, ...d }; });
    aiCredits.deduct.mockImplementation(async () => { order.push('deduct'); });
    txnModel.updateOne.mockImplementation(async () => { order.push('flag'); });
    await svc.hold('s1', 'seller1', 'listing_writer' as any, 'gen1');
    expect(order).toEqual(['create', 'deduct', 'flag']);
  });

  it('insufficient credits: the speculative hold row is removed and a 402 is raised', async () => {
    const { svc, txnModel, aiCredits } = build();
    aiCredits.deduct.mockRejectedValue(new BadRequestException('Not enough'));
    await expect(svc.hold('s1', 'seller1', 'listing_writer' as any, 'gen1')).rejects.toBeInstanceOf(HttpException);
    expect(txnModel.deleteOne).toHaveBeenCalledWith(expect.objectContaining({ deducted: false }));
  });

  it('refund gives credits back once, and never for a hold that was never deducted', async () => {
    const { svc, txnModel, aiCredits } = build();
    txnModel.findOneAndUpdate.mockResolvedValueOnce({ storeId: 's1', sellerId: 'x', creditsCharged: 5, deducted: false });
    await svc.refund('t1', 'provider failed');
    expect(aiCredits.grant).not.toHaveBeenCalled(); // crash-before-deduct window must not mint credits
    txnModel.findOneAndUpdate.mockResolvedValueOnce({ storeId: 's1', sellerId: 'x', creditsCharged: 5, deducted: true });
    await svc.refund('t2', 'provider failed');
    expect(aiCredits.grant).toHaveBeenCalledTimes(1);
    txnModel.findOneAndUpdate.mockResolvedValueOnce(null); // already refunded/captured
    await svc.refund('t2', 'again');
    expect(aiCredits.grant).toHaveBeenCalledTimes(1);
  });

  it("if the refund grant fails the row goes back to 'held' so a retry/reaper can finish", async () => {
    const { svc, txnModel, aiCredits } = build();
    txnModel.findOneAndUpdate.mockResolvedValue({ storeId: 's1', sellerId: 'x', creditsCharged: 5, deducted: true });
    aiCredits.grant.mockRejectedValue(new Error('mongo down'));
    await expect(svc.refund('t1', 'provider failed')).rejects.toThrow('mongo down');
    expect(txnModel.updateOne).toHaveBeenCalledWith({ _id: 't1', status: 'refunded' }, { $set: expect.objectContaining({ status: 'held' }) });
  });

  it('reaper refunds holds older than the cutoff and keeps going past a failure', async () => {
    const { svc, txnModel, aiCredits } = build();
    txnModel.find.mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [{ _id: { toString: () => 'a' } }, { _id: { toString: () => 'b' } }] }) }) });
    txnModel.findOneAndUpdate.mockResolvedValue({ storeId: 's1', sellerId: 'x', creditsCharged: 5, deducted: true });
    aiCredits.grant.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
    expect(await svc.reapStaleHolds(60_000)).toEqual({ refunded: 1 });
    const filter = txnModel.find.mock.calls[0][0];
    expect(filter.status).toBe('held');
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
  });
});

describe('PublicWorksheetTrialController — global daily cap', () => {
  const make = (over: any = {}) => {
    const aiStudio: any = { generateWorksheetTrial: jest.fn().mockResolvedValue({ ok: true }) };
    const redis: any = { isConnected: true, incrWithTtl: jest.fn().mockResolvedValue(1), ...over };
    return { ctl: new PublicWorksheetTrialController(aiStudio, redis), aiStudio, redis };
  };
  const dto: any = { subject: 'Math', gradeLevel: '3', topics: ['x'], questionCount: 3, includeAnswerKey: false };

  it('serves while under the cap', async () => {
    const { ctl, aiStudio } = make();
    await expect(ctl.generateTrial(dto)).resolves.toEqual({ ok: true });
    expect(aiStudio.generateWorksheetTrial).toHaveBeenCalled();
  });

  it('refuses (429) and never calls the provider once the daily cap is exceeded', async () => {
    const { ctl, aiStudio } = make({ incrWithTtl: jest.fn().mockResolvedValue(301) });
    await expect(ctl.generateTrial(dto)).rejects.toMatchObject({ status: 429 });
    expect(aiStudio.generateWorksheetTrial).not.toHaveBeenCalled();
  });

  it('fails CLOSED (503) when Redis is down — never runs an unmetered public route uncapped', async () => {
    const { ctl, aiStudio } = make({ isConnected: false });
    await expect(ctl.generateTrial(dto)).rejects.toMatchObject({ status: 503 });
    expect(aiStudio.generateWorksheetTrial).not.toHaveBeenCalled();
  });
});
