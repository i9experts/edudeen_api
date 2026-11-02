import { syncStoreListings } from './plan-listing-sync.util';

function fakeModel(found: any[] = []) {
  const calls: any[] = [];
  const model: any = {
    calls,
    updateMany: jest.fn(async (filter: any, update: any) => { calls.push({ filter, update }); return { modifiedCount: 2 }; }),
    find: jest.fn(() => ({ select: () => ({ lean: async () => found }) })),
  };
  return model;
}

describe('syncStoreListings', () => {
  it('expired: pauses active and scheduled products, remembering the old status', async () => {
    const m = fakeModel();
    const r = await syncStoreListings(m, 's1', 'expired');
    expect(r).toEqual({ paused: 4, restored: 0 });
    expect(m.calls[0].filter).toMatchObject({ storeId: 's1', status: 'active', pausedFromStatus: null });
    expect(m.calls[0].update.$set).toMatchObject({ status: 'inactive', pausedFromStatus: 'active' });
    expect(m.calls[1].update.$set).toMatchObject({ pausedFromStatus: 'scheduled' });
  });

  it('usable plan: restores only products we paused (future schedule stays scheduled)', async () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const m = fakeModel([
      { _id: 'a', pausedFromStatus: 'active' },
      { _id: 'b', pausedFromStatus: 'scheduled', scheduledAt: new Date('2026-12-01') },
      { _id: 'c', pausedFromStatus: 'scheduled', scheduledAt: new Date('2026-10-01') },
    ]);
    const r = await syncStoreListings(m, 's1', 'active', now);
    expect(r.restored).toBe(4);
    expect(m.calls[0].filter._id.$in).toEqual(['a', 'c']);
    expect(m.calls[0].update.$set).toMatchObject({ status: 'active', pausedFromStatus: null });
    expect(m.calls[1].filter._id.$in).toEqual(['b']);
    expect(m.calls[1].update.$set).toMatchObject({ status: 'scheduled' });
  });

  it('past_due and canceled also pause', async () => {
    for (const s of ['past_due', 'canceled']) {
      const m = fakeModel();
      expect((await syncStoreListings(m, 's1', s)).paused).toBe(4);
    }
  });

  it('usable plan with nothing paused does no writes', async () => {
    const m = fakeModel([]);
    const r = await syncStoreListings(m, 's1', 'trialing');
    expect(r).toEqual({ paused: 0, restored: 0 });
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});
