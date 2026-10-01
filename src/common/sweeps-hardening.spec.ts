/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { of } from 'rxjs';
import {
  NoOperatorKeysInterceptor,
  hasOperatorKey,
} from './no-operator-keys.interceptor';
import { clampInt } from './query-safety.util';
import {
  ForgotPasswordBodyDto,
  ResendOtpDto,
  ResetPasswordBodyDto,
  VerifyOtpBodyDto,
} from '../auth/dto/otp-flows.dto';
import { SchedulerService } from '../scheduler/scheduler.service';

const ctx = (req: any) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  }) as any;

describe('NoOperatorKeysInterceptor (NoSQL operator injection)', () => {
  const run = (req: any) =>
    new NoOperatorKeysInterceptor().intercept(ctx(req), {
      handle: () => of('ok'),
    });

  it('rejects $-prefixed keys anywhere in body or query', () => {
    for (const body of [
      { email: { $ne: null } },
      { a: [{ b: { $gt: '' } }] },
      { $where: '1' },
      { x: { y: { z: { $regex: '.*' } } } },
    ]) {
      expect(() => run({ body, query: {} })).toThrow(BadRequestException);
    }
    expect(() => run({ body: {}, query: { filter: { $ne: 1 } } })).toThrow(
      BadRequestException,
    );
  });

  it('lets normal payloads through (including @ and dotted keys used by JSON-LD / settings)', () => {
    expect(() =>
      run({
        body: {
          email: 'a@b.io',
          items: [{ qty: 1 }],
          '@context': 'https://schema.org',
          note: 'costs $5',
        },
        query: { page: '2' },
      }),
    ).not.toThrow();
    expect(() => run({ body: undefined, query: undefined })).not.toThrow();
  });

  it('treats absurdly deep bodies as hostile instead of walking them', () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 50; i++) {
      deep.n = {};
      deep = deep.n;
    }
    expect(hasOperatorKey(root)).toBe(true);
  });

  it('ignores non-http contexts (websockets)', () => {
    const wsCtx: any = { getType: () => 'ws' };
    expect(() =>
      new NoOperatorKeysInterceptor().intercept(wsCtx, {
        handle: () => of('ok'),
      }),
    ).not.toThrow();
  });
});

describe('auth OTP / password-reset bodies (were untyped → {"email":{"$ne":null}} matched the first account)', () => {
  const bad = { $ne: null };
  it.each([
    ['resend-otp', ResendOtpDto, { email: bad, role: 'user' }],
    [
      'verifyOtp',
      VerifyOtpBodyDto,
      { email: bad, role: 'user', otp: '123456' },
    ],
    ['forgot-password', ForgotPasswordBodyDto, { email: bad, role: 'user' }],
    [
      'reset-password',
      ResetPasswordBodyDto,
      { email: bad, role: 'user', otp: '123456', newPassword: 'longenough1' },
    ],
  ])('%s rejects an operator object as email', async (_n, cls, body) => {
    const errs = await validate(plainToInstance(cls as any, body));
    expect(errs.some((e) => e.property === 'email')).toBe(true);
  });

  it('accepts valid bodies and restricts role', async () => {
    expect(
      await validate(
        plainToInstance(VerifyOtpBodyDto, {
          email: 'a@b.io',
          role: 'seller',
          otp: '123456',
        }),
      ),
    ).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(ResendOtpDto, { email: 'a@b.io', role: 'admin' }),
        )
      ).some((e) => e.property === 'role'),
    ).toBe(true);
    expect(
      await validate(
        plainToInstance(ForgotPasswordBodyDto, {
          email: 'a@b.io',
          role: 'admin',
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('clampInt (pagination)', () => {
  it('bounds page/limit and survives arrays / objects / negatives', () => {
    expect(clampInt('100000', 20, 1, 100)).toBe(100);
    expect(clampInt('-5', 20, 1, 100)).toBe(1);
    expect(clampInt(['1', '2'], 20, 1, 100)).toBe(20);
    expect(clampInt({ $gt: 1 }, 20, 1, 100)).toBe(20);
    expect(clampInt(undefined, 20, 1, 100)).toBe(20);
    expect(clampInt('abc', 20, 1, 100)).toBe(20);
  });
});

describe('SchedulerService.runLocked', () => {
  const build = (withLock: jest.Mock) => {
    const svc: any = Object.create(SchedulerService.prototype);
    svc.redis = { withLock, isConnected: true };
    svc.logger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    return svc;
  };

  it('a failing job is logged by name and does not escape as an unhandled rejection', async () => {
    const withLock = jest.fn(
      async (_k: string, _t: number, fn: () => Promise<void>) => {
        await fn();
        return 'ran';
      },
    );
    const svc = build(withLock);
    await expect(
      svc.runLocked('boom-job', 1000, () =>
        Promise.reject(new Error('db exploded')),
      ),
    ).resolves.toBeUndefined();
    expect(svc.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('boom-job'),
    );
    expect(svc.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('db exploded'),
    );
  });

  it('still skips quietly when another instance holds the lock', async () => {
    const svc = build(jest.fn().mockResolvedValue('lock_not_acquired'));
    await svc.runLocked('j', 1000, jest.fn());
    expect(svc.logger.debug).toHaveBeenCalled();
    expect(svc.logger.error).not.toHaveBeenCalled();
  });
});
