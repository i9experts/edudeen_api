import { ForbiddenException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminReauthService } from './admin-reauth.service';
import { AdminReauthGuard } from './admin-reauth.guard';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    isConnected: true,
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    del: jest.fn(async (k: string) => { store.delete(k); }),
    incrWithTtl: jest.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }),
  };
}

describe('AdminReauthService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let log: { log: jest.Mock };
  let svc: AdminReauthService;

  beforeEach(async () => {
    redis = makeRedis();
    log = { log: jest.fn() };
    const hash = await bcrypt.hash('right-pass', 4);
    const db: any = { repositories: { adminModel: { findOne: () => ({ select: () => ({ lean: async () => ({ password: hash, name: 'A', status: 'active' }) }) }) } } };
    svc = new AdminReauthService(db, redis as any, log as any);
  });

  it('wrong password -> 401 + audit entry', async () => {
    await expect(svc.verifyPassword('a1', 'nope')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(log.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_reauth_failed', isSecurityAlert: false }));
  });

  it('correct password -> token bound to admin', async () => {
    const res = await svc.verifyPassword('a1', 'right-pass');
    expect(res.data.expiresInSeconds).toBe(300);
    expect(await svc.isValid('a1', res.data.reauthToken)).toBe(true);
    expect(await svc.isValid('a2', res.data.reauthToken)).toBe(false);
    expect(await svc.isValid('a1', 'garbage')).toBe(false);
  });

  it('locks out after 5 failures, even for the right password; flags security alert', async () => {
    for (let i = 0; i < 5; i++) await expect(svc.verifyPassword('a1', 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(log.log).toHaveBeenLastCalledWith(expect.objectContaining({ isSecurityAlert: true }));
    const err: any = await svc.verifyPassword('a1', 'right-pass').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
  });

  it('fails closed when redis is down', async () => {
    redis.isConnected = false;
    await expect(svc.verifyPassword('a1', 'right-pass')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('AdminReauthGuard', () => {
  const ctx = (headers: any, userId = 'a1') => ({ switchToHttp: () => ({ getRequest: () => ({ headers, user: { userId } }) }) }) as any;

  it('passes through without X-Inline-Edit', async () => {
    const g = new AdminReauthGuard({ isValid: jest.fn() } as any);
    await expect(g.canActivate(ctx({}))).resolves.toBe(true);
  });
  it('403 REAUTH_REQUIRED when inline edit without valid token', async () => {
    const g = new AdminReauthGuard({ isValid: jest.fn().mockResolvedValue(false) } as any);
    const err: any = await g.canActivate(ctx({ 'x-inline-edit': '1' })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe('REAUTH_REQUIRED');
  });
  it('allows with valid token', async () => {
    const isValid = jest.fn().mockResolvedValue(true);
    const g = new AdminReauthGuard({ isValid } as any);
    await expect(g.canActivate(ctx({ 'x-inline-edit': '1', 'x-admin-reauth': 'tok' }))).resolves.toBe(true);
    expect(isValid).toHaveBeenCalledWith('a1', 'tok');
  });
});