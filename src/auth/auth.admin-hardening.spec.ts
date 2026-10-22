/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { StaffService } from '../staff/staff.service';

jest.setTimeout(30_000);
const SECRET = 'test-secret';
process.env.JWT_SECRET = SECRET;

function fakeRedis(connected = true) {
  const m = new Map<string, string>();
  return {
    m,
    isConnected: connected,
    set: jest.fn(async (k: string, v: string) => { m.set(k, v); }),
    get: jest.fn(async (k: string) => m.get(k) ?? null),
    del: jest.fn(async (k: string) => { m.delete(k); }),
    consume: jest.fn(async (k: string) => (connected ? m.delete(k) : false)), // like RedisService.consume
    incrWithTtl: jest.fn(async (k: string) => { const n = (Number(m.get(k)) || 0) + 1; m.set(k, String(n)); return n; }),
  };
}

describe('AuthService — admin hardening', () => {
  let admin: any;
  let redis: ReturnType<typeof fakeRedis>;
  let staffSvc: { gateLogin: jest.Mock; assertSessionAllowed: jest.Mock };
  let service: AuthService;
  let jwt: JwtService;

  const build = async (connected = true) => {
    admin = {
      _id: 'adm-1', email: 'owner@edudeen.com', role: 'admin', name: 'Owner', tokenVersion: 0, isVerified: true, status: 'active', isDelete: false,
      password: await bcrypt.hash('Correct-horse-9', 4),
    };
    admin.save = jest.fn().mockResolvedValue(admin);
    const model: any = {
      findOne: jest.fn(async (q: any) => (String(q.email).toLowerCase() === admin.email ? admin : null)),
      findById: jest.fn(async (id: string) => (id === admin._id ? admin : null)),
    };
    redis = fakeRedis(connected);
    staffSvc = { gateLogin: jest.fn(), assertSessionAllowed: jest.fn() };
    jwt = new JwtService({ secret: SECRET });
    const db: any = { repositories: { userModel: model, sellerModel: model, adminModel: model } };
    const moduleRef: any = { get: (t: any) => (t === StaffService ? staffSvc : undefined) };
    service = new AuthService(db, { sendOtp: jest.fn() } as any, redis as any, { log: jest.fn() } as any, jwt, moduleRef);
  };
  const login = (email: string, password: string, totp?: string) => service.login({ email, password, role: 'admin', totp } as any, '1.2.3.4');

  describe('per-email lockout', () => {
    beforeEach(() => build());

    it('locks after 5 wrong passwords, even for the right password, for known and unknown emails alike', async () => {
      for (let i = 0; i < 5; i++) await expect(login('owner@edudeen.com', 'wrong')).rejects.toThrow('Invalid email or password');
      await expect(login('owner@edudeen.com', 'Correct-horse-9')).rejects.toMatchObject({ status: 429 });

      for (let i = 0; i < 5; i++) await expect(login('nobody@edudeen.com', 'wrong')).rejects.toThrow('Invalid email or password');
      const real = await login('owner@edudeen.com', 'Correct-horse-9').catch((e) => e);
      const fake = await login('nobody@edudeen.com', 'whatever').catch((e) => e);
      expect(fake.status).toBe(429);
      expect(fake.message).toBe(real.message); // no enumeration
    });

    it('a successful login resets the counter', async () => {
      for (let i = 0; i < 4; i++) await expect(login('owner@edudeen.com', 'wrong')).rejects.toThrow();
      const ok: any = await login('owner@edudeen.com', 'Correct-horse-9');
      expect(ok.success).toBe(true);
      for (let i = 0; i < 4; i++) await expect(login('owner@edudeen.com', 'wrong')).rejects.toThrow('Invalid email or password');
      expect((await login('owner@edudeen.com', 'Correct-horse-9')).success).toBe(true);
    });

    it('email case does not dodge the counter', async () => {
      for (let i = 0; i < 5; i++) await expect(login(i % 2 ? 'OWNER@edudeen.com' : 'owner@edudeen.com', 'wrong')).rejects.toThrow();
      await expect(login('Owner@Edudeen.com', 'Correct-horse-9')).rejects.toMatchObject({ status: 429 });
    });

    it('wrong authenticator/e-mail codes count; "code required" does not', async () => {
      admin.isStaff = true;
      staffSvc.gateLogin.mockRejectedValue({ getResponse: () => ({ code: 'EMAIL_CODE_REQUIRED' }) });
      for (let i = 0; i < 6; i++) await expect(login('owner@edudeen.com', 'Correct-horse-9')).rejects.toBeDefined();
      staffSvc.gateLogin.mockRejectedValue({ getResponse: () => ({ code: 'TOTP_INVALID' }) });
      for (let i = 0; i < 5; i++) await expect(login('owner@edudeen.com', 'Correct-horse-9', '000000')).rejects.toBeDefined();
      await expect(login('owner@edudeen.com', 'Correct-horse-9', '000000')).rejects.toMatchObject({ status: 429 });
    });

    it('buyer/seller logins are not subject to the admin lock', async () => {
      for (let i = 0; i < 7; i++) await expect(service.login({ email: 'owner@edudeen.com', password: 'wrong', role: 'user' } as any)).rejects.toThrow('Invalid email or password');
      expect(redis.m.size).toBe(0);
    });
  });

  describe('sessions', () => {
    beforeEach(() => build());

    it('admin access token lives 2h, buyer token 24h; admin refresh token carries a jti', async () => {
      const a = await service.issueSession(admin);
      const pa: any = jwt.decode(a.accessToken);
      expect(pa.exp - pa.iat).toBe(AuthService.ADMIN_ACCESS_TTL_SECONDS);
      expect(AuthService.ADMIN_ACCESS_TTL_SECONDS).toBeLessThanOrEqual(2 * 3600);
      const r: any = jwt.decode(a.refreshToken);
      expect(r.jti).toBeTruthy();
      expect(redis.m.has(`admin-rt:${r.jti}`)).toBe(true);

      const b = await service.issueSession({ ...admin, role: 'user' });
      const pb: any = jwt.decode(b.accessToken);
      expect(pb.exp - pb.iat).toBe(24 * 3600);
      expect((jwt.decode(b.refreshToken) as any).jti).toBeUndefined();
    });

    it('rotates: a refresh token works once, the new pair works, and the old token is dead', async () => {
      const s1 = await service.issueSession(admin);
      const r1: any = await service.refresh(s1.refreshToken, '1.2.3.4');
      expect(r1.data.token.refreshToken).not.toBe(s1.refreshToken);
      const r2: any = await service.refresh(r1.data.token.refreshToken, '1.2.3.4');
      expect(r2.success).toBe(true);
    });

    it('reusing a burnt refresh token revokes every session (tokenVersion bump)', async () => {
      const s1 = await service.issueSession(admin);
      const fresh: any = await service.refresh(s1.refreshToken);
      await expect(service.refresh(s1.refreshToken)).rejects.toThrow('Session expired');
      expect(admin.tokenVersion).toBe(1);
      // the legitimately rotated token is now stale too
      await expect(service.refresh(fresh.data.token.refreshToken)).rejects.toThrow('Session revoked');
    });

    it('a refresh token without jti (old format) and a refresh without Redis are refused for admin', async () => {
      const legacy = jwt.sign({ sub: admin._id, email: admin.email, role: 'admin', tokenVersion: 0, typ: 'refresh' }, { expiresIn: '7d' });
      await expect(service.refresh(legacy)).rejects.toThrow('Session expired');
      expect(admin.tokenVersion).toBe(0); // no jti: not a theft signal, just re-login

      await build(false);
      const s = await service.issueSession(admin);
      await expect(service.refresh(s.refreshToken)).rejects.toThrow('Session expired');
    });

    it('refresh re-checks staff suspension / access window and does not burn the token when refused', async () => {
      const s = await service.issueSession(admin);
      staffSvc.assertSessionAllowed.mockImplementation(() => { throw new Error('Your access period has ended.'); });
      await expect(service.refresh(s.refreshToken, '9.9.9.9')).rejects.toThrow('access period');
      expect(staffSvc.assertSessionAllowed).toHaveBeenCalledWith(admin, '9.9.9.9');
      staffSvc.assertSessionAllowed.mockReset();
      await expect(service.refresh(s.refreshToken)).resolves.toMatchObject({ success: true });
    });

    it('buyer refresh is unchanged (not single-use)', async () => {
      const u = { ...admin, role: 'user' };
      admin.role = 'user';
      const s = await service.issueSession(u);
      await service.refresh(s.refreshToken);
      await expect(service.refresh(s.refreshToken)).resolves.toMatchObject({ success: true });
    });
  });

  describe('admin password reset', () => {
    beforeEach(() => build());
    it('forgot/reset refuse admin identically for any email and send nothing', async () => {
      const a = await service.forgotPassword('owner@edudeen.com', 'admin').catch((e) => e);
      const b = await service.forgotPassword('nobody@edudeen.com', 'admin').catch((e) => e);
      expect(a.status).toBe(400);
      expect(a.message).toBe(b.message);
      const c = await service.resetPassword('owner@edudeen.com', 'admin', '123456', 'Brand-new-pass-1').catch((e) => e);
      expect(c.status).toBe(400);
      expect(admin.save).not.toHaveBeenCalled();
    });
  });

  describe('facebook login', () => {
    beforeEach(() => build());
    it('fails closed when the app id / secret are not configured', async () => {
      delete process.env.FACEBOOK_APP_ID; delete process.env.FACEBOOK_APP_SECRET;
      const f = jest.spyOn(globalThis, 'fetch' as any);
      await expect(service.socialLogin({ authProvider: 'facebook', socialId: '1', token: 'tok' } as any)).rejects.toThrow(/not configured/);
      expect(f).not.toHaveBeenCalled();
      f.mockRestore();
    });
  });
});
