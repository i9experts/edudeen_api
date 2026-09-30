/* eslint-disable prettier/prettier */
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

const SECRET = 'test-secret';
process.env.JWT_SECRET = SECRET;
const hashOtp = (o: string) => (AuthService as any).hashOtp(o);

function makeAccount(overrides: Record<string, any> = {}) {
  const acc: any = {
    _id: 'acc-1',
    email: 'victim@school.edu',
    role: 'user',
    tokenVersion: 0,
    isVerified: true,
    status: 'active',
    isDelete: false,
    otp: null,
    otpExpiresAt: null,
    otpAttempts: 0,
    ...overrides,
  };
  acc.save = jest.fn().mockResolvedValue(acc);
  return acc;
}

describe('AuthService — security', () => {
  let service: AuthService;
  let userModel: any;
  let jwt: JwtService;

  const setup = (findOneImpl: (q: any) => any) => {
    userModel = jest.fn().mockImplementation((doc: any) => makeAccount({ ...doc, _id: 'new-acc' }));
    userModel.findOne = jest.fn().mockImplementation(async (q: any) => findOneImpl(q));
    userModel.findById = jest.fn();
    jwt = new JwtService({ secret: SECRET });
    const db: any = { repositories: { userModel, sellerModel: userModel, adminModel: userModel } };
    const redis: any = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
    const otp: any = { sendOtp: jest.fn() };
    const activity: any = { log: jest.fn() };
    service = new AuthService(db, otp, redis, activity, jwt);
  };

  const mockGoogle = (payload: any) =>
    jest.spyOn((service as any).googleClient, 'verifyIdToken').mockResolvedValue({ getPayload: () => payload } as never);

  beforeEach(() => { process.env.GOOGLE_CLIENT_IDS = 'web-id,android-id'; });
  afterEach(() => jest.restoreAllMocks());

  describe('social login', () => {
    it('does NOT log in to an account whose email was only claimed in the request body', async () => {
      const victim = makeAccount();
      setup((q) => (q.email instanceof RegExp && q.email.test(victim.email) ? victim : null));
      // Attacker's own valid Google token: different, verified email.
      mockGoogle({ sub: 'attacker-sub', email: 'attacker@gmail.com', email_verified: true });

      const res: any = await service.socialLogin({
        authProvider: 'google', socialId: 'attacker-sub', token: 'tok', email: 'victim@school.edu',
      } as any);

      expect(res.data.user.email).toBe('attacker@gmail.com');
      expect(res.data.user.id).not.toBe(victim._id);
    });

    it('does not link by an unverified provider email', async () => {
      const victim = makeAccount();
      setup((q) => (q.email ? victim : null));
      mockGoogle({ sub: 'x-sub', email: 'victim@school.edu', email_verified: false });
      await expect(
        service.socialLogin({ authProvider: 'google', socialId: 'x-sub', token: 'tok' } as any),
      ).rejects.toThrow(/verified email/);
    });

    it('links by a provider-verified email, case-insensitively', async () => {
      const owner = makeAccount({ email: 'Teacher@School.edu' });
      setup((q) => (q.email instanceof RegExp && q.email.test(owner.email) ? owner : null));
      mockGoogle({ sub: 'owner-sub', email: 'teacher@school.edu', email_verified: true });
      const res: any = await service.socialLogin({ authProvider: 'google', socialId: 'owner-sub', token: 'tok' } as any);
      expect(res.data.user.id).toBe('acc-1');
    });

    it('rejects a token whose subject does not match socialId', async () => {
      setup(() => null);
      mockGoogle({ sub: 'someone-else', email: 'a@b.com', email_verified: true });
      await expect(
        service.socialLogin({ authProvider: 'google', socialId: 'claimed', token: 'tok' } as any),
      ).rejects.toThrow(/Invalid Google token/);
    });
  });

  describe('tokens', () => {
    it('refresh rejects an access token', async () => {
      setup(() => null);
      const access = jwt.sign({ sub: 'acc-1', role: 'user', typ: 'access' });
      await expect(service.refresh(access)).rejects.toThrow(/Invalid refresh token/);
    });

    it('refresh rejects a token issued before a password reset', async () => {
      setup(() => null);
      userModel.findById.mockResolvedValue(makeAccount({ tokenVersion: 1 }));
      const refresh = jwt.sign({ sub: 'acc-1', role: 'user', typ: 'refresh', tokenVersion: 0 });
      await expect(service.refresh(refresh)).rejects.toThrow(/revoked/);
    });

    it('refresh issues a new typed pair for a valid refresh token', async () => {
      setup(() => null);
      userModel.findById.mockResolvedValue(makeAccount());
      const refresh = jwt.sign({ sub: 'acc-1', role: 'user', typ: 'refresh', tokenVersion: 0 });
      const res: any = await service.refresh(refresh);
      expect((jwt.verify(res.data.token.accessToken) as any).typ).toBe('access');
      expect((jwt.verify(res.data.token.refreshToken) as any).typ).toBe('refresh');
    });
  });

  describe('password reset OTP', () => {
    const future = () => new Date(Date.now() + 60_000);

    it('burns the code after 5 wrong attempts', async () => {
      const acc = makeAccount({ otp: hashOtp('123456'), otpExpiresAt: future() });
      setup(() => acc);
      for (let i = 0; i < 5; i++) {
        await expect(service.resetPassword(acc.email, 'user', '000000', 'newpassword1')).rejects.toThrow(/Invalid OTP/);
      }
      expect(acc.otp).toBeNull();
      // Even the correct code no longer works.
      await expect(service.resetPassword(acc.email, 'user', '123456', 'newpassword1')).rejects.toThrow();
    });

    it('revokes existing sessions on a successful reset', async () => {
      const acc = makeAccount({ otp: hashOtp('123456'), otpExpiresAt: future(), tokenVersion: 3 });
      setup(() => acc);
      await service.resetPassword(acc.email, 'user', '123456', 'newpassword1');
      expect(acc.tokenVersion).toBe(4);
      expect(await bcrypt.compare('newpassword1', acc.password)).toBe(true);
    });

    it('stores the OTP hashed, never in plaintext', async () => {
      const acc = makeAccount();
      setup(() => acc);
      await service.forgotPassword(acc.email, 'user');
      const sent = (service as any).otpService.sendOtp.mock.calls[0][1];
      expect(acc.otp).not.toBe(sent);
      expect(acc.otp).toBe(hashOtp(sent));
    });

    it('does not accept a legacy plaintext-stored OTP', async () => {
      const acc = makeAccount({ otp: '123456', otpExpiresAt: future() });
      setup(() => acc);
      await expect(service.resetPassword(acc.email, 'user', '123456', 'newpassword1')).rejects.toThrow(/Invalid OTP/);
    });

    it('rejects a too-short new password', async () => {
      const acc = makeAccount({ otp: hashOtp('123456'), otpExpiresAt: future() });
      setup(() => acc);
      await expect(service.resetPassword(acc.email, 'user', '123456', 'short')).rejects.toThrow(/8 and 72/);
    });
  });

  describe('error mapping', () => {
    it('keeps a validation error as 400 instead of rewrapping it as 401', async () => {
      const acc = makeAccount({ otp: hashOtp('123456'), otpExpiresAt: new Date(Date.now() + 60_000) });
      setup(() => acc);
      await expect(service.resetPassword(acc.email, 'user', '123456', 'short')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('turns an unexpected error into a generic 500 without leaking its message', async () => {
      setup(() => { throw new Error('mongo://user:secret@host exploded'); });
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      const err: any = await service.forgotPassword('a@b.co', 'user').catch((e) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(JSON.stringify(err.getResponse())).not.toMatch(/secret|mongo/);
    });
  });
});
