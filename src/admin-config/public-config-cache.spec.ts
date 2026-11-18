/* eslint-disable prettier/prettier */
import { AdminConfigService } from './admin-config.service';

function make() {
  const config: any = { socialLinks: {}, payoutConfig: { payoutFrequency: 'monthly' } };
  const model: any = { findOneAndUpdate: jest.fn(async () => config) };
  const storeModel: any = { exists: jest.fn(async () => ({ _id: 's1' })) };
  const mem = new Map<string, string>();
  const redis: any = {
    get: jest.fn(async (k: string) => mem.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mem.set(k, v); }),
    del: jest.fn(async (k: string) => { mem.delete(k); }),
  };
  const svc = new AdminConfigService({ repositories: { platformConfigModel: model, storeModel } } as any, { log: jest.fn() } as any, redis);
  return { svc, storeModel, redis };
}

describe('public platform config cache', () => {
  it('builds once, then serves the Redis copy (no extra store query)', async () => {
    const { svc, storeModel, redis } = make();
    const a = await svc.getPublicConfig();
    const b = await svc.getPublicConfig();
    expect(b).toEqual(a);
    expect(storeModel.exists).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('an admin write drops the shared copy so the next read is fresh', async () => {
    const { svc, storeModel, redis } = make();
    await svc.getPublicConfig();
    (svc as any).invalidateCache();
    expect(redis.del).toHaveBeenCalledWith('platform-config:public:v1');
    await svc.getPublicConfig();
    expect(storeModel.exists).toHaveBeenCalledTimes(2);
  });

  it('works without Redis (live read every time)', async () => {
    const model: any = { findOneAndUpdate: jest.fn(async () => ({ socialLinks: {} })) };
    const storeModel: any = { exists: jest.fn(async () => null) };
    const svc = new AdminConfigService({ repositories: { platformConfigModel: model, storeModel } } as any, { log: jest.fn() } as any);
    const r: any = await svc.getPublicConfig();
    expect(r.success).toBe(true);
  });
});
