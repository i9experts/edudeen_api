/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.setTimeout(30_000);
process.env.JWT_SECRET = 'test-secret';
const hashOtp = (o: string) => (AuthService as any).hashOtp(o);

function makeAccount(over: Record<string, any> = {}) {
  const acc: any = {
    _id: 'acc-1',
    email: 'a@school.edu',
    role: 'user',
    tokenVersion: 0,
    isVerified: false,
    status: 'active',
    isDelete: false,
    otp: hashOtp('123456'),
    otpExpiresAt: new Date(Date.now() + 60_000),
    otpAttempts: 0,
    ...over,
  };
  acc.save = jest.fn().mockResolvedValue(acc);
  return acc;
}
function setup(acc: any | null) {
  const model: any = { findOne: jest.fn(async () => acc), findById: jest.fn() };
  const db: any = {
    repositories: { userModel: model, sellerModel: model, adminModel: model },
  };
  const redis: any = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
  return new AuthService(
    db,
    { sendOtp: jest.fn() } as any,
    redis,
    { log: jest.fn() } as any,
    new JwtService({ secret: 'test-secret' }),
  );
}
/** The HTTP body Nest would send for the thrown exception. */
const body = async (p: Promise<unknown>) => {
  const err: any = await p.catch((e) => e);
  expect(err).toBeInstanceOf(UnauthorizedException);
  return { status: err.getStatus(), ...(err.getResponse() as object) } as any;
};

const verify = (svc: AuthService, otp: string) =>
  svc.verifyOtp('a@school.edu', 'user', otp);
const reset = (svc: AuthService, otp: string) =>
  svc.resetPassword('a@school.edu', 'user', otp, 'newpassword1');

describe.each([
  ['verifyOtp', verify],
  ['reset-password', reset],
])(
  '%s — machine-readable OTP errors (status and message unchanged)',
  (_name, run) => {
    it('a wrong code: 401 "Invalid OTP", OTP_INVALID, and how many tries are left', async () => {
      const acc = makeAccount();
      const svc = setup(acc);
      const b1 = await body(run(svc, '000000'));
      expect(b1).toMatchObject({
        status: 401,
        message: 'Invalid OTP',
        code: 'OTP_INVALID',
        attemptsLeft: 4,
      });
      const b2 = await body(run(svc, '000000'));
      expect(b2).toMatchObject({ code: 'OTP_INVALID', attemptsLeft: 3 });
    });

    it('the attempt that burns the code returns OTP_LOCKED (still 401 "Invalid OTP"), with no attemptsLeft', async () => {
      const acc = makeAccount();
      const svc = setup(acc);
      for (let i = 0; i < 4; i++)
        expect((await body(run(svc, '000000'))).code).toBe('OTP_INVALID');
      const fifth = await body(run(svc, '000000'));
      expect(fifth).toMatchObject({
        status: 401,
        message: 'Invalid OTP',
        code: 'OTP_LOCKED',
      });
      expect('attemptsLeft' in fifth).toBe(false);
      expect(acc.otp).toBeNull();
    });

    it('after the burn even the right code reports the code as gone (OTP_EXPIRED, "request a new one")', async () => {
      const acc = makeAccount();
      const svc = setup(acc);
      for (let i = 0; i < 5; i++) await body(run(svc, '000000'));
      expect(await body(run(svc, '123456'))).toMatchObject({
        status: 401,
        message: 'OTP has expired, please request a new one',
        code: 'OTP_EXPIRED',
      });
    });

    it('an expired code: 401 with OTP_EXPIRED', async () => {
      const svc = setup(
        makeAccount({ otpExpiresAt: new Date(Date.now() - 1000) }),
      );
      expect(await body(run(svc, '123456'))).toMatchObject({
        status: 401,
        message: 'OTP has expired, please request a new one',
        code: 'OTP_EXPIRED',
      });
    });

    it('a code that is out of attempts but still stored is OTP_LOCKED', async () => {
      const svc = setup(makeAccount({ otpAttempts: 5 }));
      expect(await body(run(svc, '123456'))).toMatchObject({
        status: 401,
        message: 'Too many wrong attempts, please request a new OTP',
        code: 'OTP_LOCKED',
      });
    });

    it('the correct code still succeeds', async () => {
      const svc = setup(makeAccount());
      await expect(run(svc, '123456')).resolves.toMatchObject({
        success: true,
      });
    });
  },
);

describe('reset-password for an unknown email stays indistinguishable from a first wrong attempt', () => {
  it('401 "Invalid OTP", OTP_INVALID, attemptsLeft 4 — same as a real account\'s first miss', async () => {
    const unknown = await body(reset(setup(null), '000000'));
    const real = await body(reset(setup(makeAccount()), '000000'));
    expect(unknown).toEqual(real);
  });
});
