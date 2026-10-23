import { AdminPendingService, PENDING_PERMISSION } from './admin-pending.service';

function make(redisHit: string | null = null) {
  const count = (n: number) => jest.fn().mockResolvedValue(n);
  const repos: any = {
    payoutModel: { countDocuments: count(2) },
    manualPaymentProofModel: { countDocuments: count(3) },
    productModel: { countDocuments: count(4) },
    refundRequestModel: { countDocuments: count(5) },
    promotionRequestModel: { countDocuments: count(6) },
  };
  const redis: any = { get: jest.fn().mockResolvedValue(redisHit), set: jest.fn().mockResolvedValue(undefined) };
  return { svc: new AdminPendingService({ repositories: repos } as any, redis), repos, redis };
}

describe('AdminPendingService', () => {
  it('counts every queue once and caches the answer', async () => {
    const { svc, repos, redis } = make();
    expect(await svc.counts()).toEqual({ payouts: 2, paymentProofs: 3, listings: 4, refunds: 5, promotions: 6 });
    expect(redis.set).toHaveBeenCalledWith('admin:pending-counts:v1', expect.any(String), 45);
    await svc.counts(); // served from memory (redis mock keeps missing)
    expect(repos.payoutModel.countDocuments).toHaveBeenCalledTimes(1);
  });

  it('uses the Redis copy when present (no database work)', async () => {
    const { svc, repos } = make(JSON.stringify({ payouts: 9, paymentProofs: 0, listings: 0, refunds: 0, promotions: 0 }));
    expect((await svc.counts()).payouts).toBe(9);
    expect(repos.payoutModel.countDocuments).not.toHaveBeenCalled();
  });

  it('owner sees every queue and a total', async () => {
    const { svc } = make();
    expect(await svc.forPermissions(null)).toEqual({ payouts: 2, paymentProofs: 3, listings: 4, refunds: 5, promotions: 6, total: 20 });
  });

  it('staff only get the queues their rights cover', async () => {
    const { svc } = make();
    const out = await svc.forPermissions(new Set([PENDING_PERMISSION.paymentProofs, PENDING_PERMISSION.listings]));
    expect(out).toEqual({ paymentProofs: 3, listings: 4, total: 7 });
    expect(await svc.forPermissions(new Set())).toEqual({ total: 0 });
  });

  it('a broken Redis does not break the endpoint', async () => {
    const { svc, redis } = make();
    redis.get.mockRejectedValue(new Error('down'));
    redis.set.mockRejectedValue(new Error('down'));
    expect((await svc.counts()).listings).toBe(4);
  });
});
