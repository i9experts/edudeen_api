/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy test */
import { BannersService } from './banner.service';

function make(rows: any[]) {
  const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  const bannerModel = {
    find: jest.fn(() => ({ sort: () => ({ lean: () => Promise.resolve(rows) }) })),
    updateMany,
  };
  const svc = new BannersService({ repositories: { bannerModel } } as any, {} as any, {} as any);
  return { svc, updateMany };
}

describe('admin banner schedule', () => {
  it('lists every status and flags what is live right now', async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 3600_000);
    const { svc } = make([
      { _id: 'a', status: 'active', endAt: null },
      { _id: 'b', status: 'scheduled', startAt: future },
      { _id: 'c', status: 'scheduled', startAt: past },
      { _id: 'd', status: 'draft' },
      { _id: 'e', status: 'active', endAt: past },
    ]);
    const res = await svc.findAllForAdmin();
    expect(res.data.map((b: any) => [b._id, b.live])).toEqual([['a', true], ['b', false], ['c', true], ['d', false], ['e', false]]);
  });

  it('the minute tick activates due scheduled banners and expires finished ones', async () => {
    const { svc, updateMany } = make([]);
    const now = new Date();
    const r = await svc.runScheduleTick(now);
    expect(r).toEqual({ activated: 1, expired: 1 });
    expect(updateMany.mock.calls[0][0]).toMatchObject({ status: 'scheduled', startAt: { $lte: now } });
    expect(updateMany.mock.calls[0][1]).toEqual({ $set: { status: 'active', isActive: true } });
    expect(updateMany.mock.calls[1][1]).toEqual({ $set: { status: 'expired', isActive: false } });
  });
});
