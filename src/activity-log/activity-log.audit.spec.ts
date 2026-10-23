/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Logger } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { requestAuditMiddleware } from '../common/request-audit.context';

function make(create: jest.Mock) {
  const emit = jest.fn();
  const svc = new ActivityLogService({ repositories: { activityLogModel: { create } } } as any, { emitNewActivity: emit } as any);
  return { svc, emit };
}
const entry = { category: 'finance' as const, action: 'x', actorId: 'a1' };

describe('ActivityLogService.log — audit trail failures are not silent', () => {
  it('retries once, and resolves true when the second write works', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ toObject: () => ({}) });
    const { svc, emit } = make(create);
    await expect(svc.log(entry)).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalled();
  });

  it('resolves false (never throws) and writes the whole entry to the error log when both attempts fail', async () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc } = make(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(svc.log({ ...entry, description: 'payout approved', targetId: 'p1' })).resolves.toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('AUDIT ENTRY LOST (finance/x)'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('payout approved'));
    err.mockRestore();
  });

  it('a failing live-emit does not turn a stored entry into a failure', async () => {
    const create = jest.fn().mockResolvedValue({ toObject: () => ({}) });
    const { svc, emit } = make(create);
    emit.mockImplementation(() => { throw new Error('socket'); });
    await expect(svc.log(entry)).resolves.toBe(true);
  });

  it('fills ip + user-agent from the request when the caller did not pass them, and explicit values win', async () => {
    const create = jest.fn().mockResolvedValue({ toObject: () => ({}) });
    const { svc } = make(create);
    await new Promise<void>((resolve) => requestAuditMiddleware({ ip: '10.0.0.7', headers: { 'user-agent': 'Chrome/1' } }, {}, () => {
      void svc.log(entry).then(() => svc.log({ ...entry, ip: '1.1.1.1', userAgent: 'x' })).then(() => resolve());
    }));
    expect(create.mock.calls[0][0]).toMatchObject({ ip: '10.0.0.7', userAgent: 'Chrome/1' });
    expect(create.mock.calls[1][0]).toMatchObject({ ip: '1.1.1.1', userAgent: 'x' });
  });

  it('outside a request there is simply no ip', async () => {
    const create = jest.fn().mockResolvedValue({ toObject: () => ({}) });
    const { svc } = make(create);
    await svc.log(entry);
    expect(create.mock.calls[0][0]).toMatchObject({ ip: null, userAgent: null });
  });
});