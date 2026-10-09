import { resolveStoreNames } from './store-name.util';

describe('resolveStoreNames', () => {
  it('runs one query for many products, de-duplicating store ids', async () => {
    const lean = jest.fn().mockResolvedValue([
      { _id: 's1', name: 'Alpha Books' },
      { _id: 's2', name: 'Beta Learning' },
    ]);
    const select = jest.fn().mockReturnValue({ lean });
    const find = jest.fn().mockReturnValue({ select });

    const names = await resolveStoreNames({ find } as any, ['s1', 's2', 's1', null, undefined, 's3']);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ _id: { $in: ['s1', 's2', 's3'] } });
    expect(names.get('s1')).toBe('Alpha Books');
    expect(names.get('s2')).toBe('Beta Learning');
    expect(names.has('s3')).toBe(false);
  });

  it('skips the query when there are no store ids', async () => {
    const find = jest.fn();
    const names = await resolveStoreNames({ find } as any, [null, undefined]);
    expect(find).not.toHaveBeenCalled();
    expect(names.size).toBe(0);
  });
});
