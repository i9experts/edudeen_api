import { AdminFinanceService } from './admin-finance.service';

/** getSellerBalances filters, sorts and pages in the database (it used to load every balance row). */
function make(rows: any[] = [], total = 0) {
  const find = jest.fn().mockReturnValue({ sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(rows) });
  const lean = (v: any[]) => ({ select: () => ({ limit: () => ({ lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) }) });
  const repos: any = {
    sellerBalanceModel: { find, countDocuments: jest.fn().mockResolvedValue(total) },
    sellerModel: { find: jest.fn().mockReturnValue(lean([{ _id: 'sel1', name: 'Ali', email: 'ali@x.com' }])) },
    storeModel: { find: jest.fn().mockReturnValue(lean([{ _id: 'st1', name: 'Ali Store' }])) },
  };
  // Redis misses (get -> null) so the cache wrapper just runs the query.
  const redis: any = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const svc = new AdminFinanceService({ repositories: repos } as any, redis, {} as any, {} as any, {} as any);
  return { svc, repos, find };
}

describe('AdminFinanceService.getSellerBalances', () => {
  it('pages in the database: skip/limit/sort, never an unbounded find', async () => {
    const { svc, repos, find } = make([{ storeId: 'st1', sellerId: 'sel1', availableBalance: 5, pendingBalance: 1, currency: 'USD' }], 41);
    const res: any = await svc.getSellerBalances({ page: '3', limit: '10', sort: 'pendingBalance', order: 'asc' });
    expect(repos.sellerBalanceModel.countDocuments).toHaveBeenCalledWith({});
    expect(find).toHaveBeenCalledWith({});
    const chain = find.mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ pendingBalance: 1, _id: 1 });
    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(res.data.pagination).toEqual({ page: 3, limit: 10, total: 41, totalPages: 5 });
    expect(res.data.sellers[0]).toMatchObject({ storeName: 'Ali Store', sellerName: 'Ali' });
  });

  it('flaggedOnly and search become database filters', async () => {
    const { svc, find } = make();
    await svc.getSellerBalances({ flaggedOnly: 'true', search: 'ali' });
    const filter = find.mock.calls[0][0];
    expect(filter.isFlaggedForReview).toBe(true);
    expect(filter.$or).toEqual([{ sellerId: { $in: ['sel1'] } }, { storeId: { $in: ['st1'] } }]);
  });

  it('search text is escaped, bad sort falls back, limit is capped', async () => {
    const { svc, repos, find } = make();
    await svc.getSellerBalances({ search: 'a.*(', sort: '$where', limit: '999999' });
    expect((repos.sellerModel.find.mock.calls[0][0].$or[0].name.$regex)).toBe('a\\.\\*\\(');
    const chain = find.mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ availableBalance: -1, _id: 1 });
    expect(chain.limit).toHaveBeenCalledWith(5000);
  });
});
