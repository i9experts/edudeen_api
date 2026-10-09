/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { HttpException, ServiceUnavailableException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PhoneVerificationService } from './phone-verification.service';
import { MAX_VERIFY_ATTEMPTS, RESEND_COOLDOWN_MS, hashPhoneOtp } from './phone-otp.util';

// ── tiny in-memory model: equality + $gt/$ne/$nin only ──────────────────────
const eq = (a: any, b: any) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
function matches(doc: any, q: any): boolean {
  return Object.entries(q).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$gt' in v) return doc[k] != null && doc[k] > v.$gt;
      if ('$ne' in v) return doc[k] !== v.$ne;
      if ('$nin' in v) return !v.$nin.includes(doc[k]);
    }
    return eq(doc[k] ?? null, v ?? null);
  });
}
function fakeModel(initial: any[] = []) {
  const docs: any[] = initial.map((d) => ({ ...d }));
  const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) });
  const apply = (d: any, u: any) => {
    Object.assign(d, u.$set ?? {});
    for (const [k, n] of Object.entries(u.$inc ?? {})) d[k] = (d[k] ?? 0) + (n as number);
  };
  return {
    docs,
    findOne: jest.fn((q: any) => chain(docs.find((d) => matches(d, q)) ?? null)),
    findById: jest.fn((id: string) => chain(docs.find((d) => d._id === id) ?? null)),
    exists: jest.fn(async (q: any) => (docs.some((d) => matches(d, q)) ? { _id: 'x' } : null)),
    countDocuments: jest.fn(async (q: any) => docs.filter((d) => matches(d, q)).length),
    create: jest.fn(async (d: any) => { if (d.phone && docs.some((x) => x.phone === d.phone)) throw Object.assign(new Error('dup'), { code: 11000 }); const row = { ...d }; docs.push(row); return row; }),
    findOneAndUpdate: jest.fn(async (q: any, u: any) => { const d = docs.find((x) => matches(x, q)); if (!d) return null; apply(d, u); return d; }),
    updateOne: jest.fn(async (q: any, u: any) => { const d = docs.find((x) => matches(x, q)); if (d) apply(d, u); return { matchedCount: d ? 1 : 0 }; }),
  };
}

const PHONE = '+923001234567';
function make(opts: { configured?: boolean; sendOk?: boolean; accounts?: any[]; otps?: any[] } = {}) {
  const otpModel = fakeModel(opts.otps);
  const accounts = fakeModel(opts.accounts ?? [{ _id: 'u1', isDelete: false, status: 'active' }]);
  const sent: any[] = [];
  const channels: any = {
    isAnyChannelConfigured: () => opts.configured ?? true,
    sendDirect: jest.fn(async (args: any) => { sent.push(args); return opts.sendOk === false ? { ok: false } : { ok: true, channel: 'whatsapp' }; }),
  };
  const db: any = { repositories: { userModel: accounts, sellerModel: fakeModel([{ _id: 's1', isDelete: false, status: 'active' }]) } };
  const svc = new PhoneVerificationService(db, channels, otpModel as any);
  return { svc, otpModel, accounts, channels, sent };
}
const codeOf = (sent: any[]) => sent[sent.length - 1].vars.code as string;

describe('PhoneVerificationService', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });

  it('returns a clear 503 when no WhatsApp/SMS channel is configured, and reports it as unavailable', async () => {
    const { svc, channels } = make({ configured: false });
    await expect(svc.sendCode('u1', 'user', '03001234567')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(channels.sendDirect).not.toHaveBeenCalled();
    expect(svc.availability().data.available).toBe(false);
  });

  it('rejects an invalid number with 400 before sending anything', async () => {
    const { svc, channels } = make();
    await expect(svc.sendCode('u1', 'user', 'abc')).rejects.toBeInstanceOf(BadRequestException);
    expect(channels.sendDirect).not.toHaveBeenCalled();
  });

  it('sends a hashed 6-digit code, then verifies it and stores the verified E.164 number on the account', async () => {
    const { svc, otpModel, accounts, sent } = make();
    const res = await svc.sendCode('u1', 'user', '0300 1234567');
    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PHONE, event: 'phone_otp' });
    const code = codeOf(sent);
    expect(code).toMatch(/^\d{6}$/);
    const stored = otpModel.docs[0];
    expect(stored.codeHash).toBe(hashPhoneOtp(PHONE, code));
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const ok = await svc.verifyCode('u1', 'user', '03001234567', code);
    expect(ok.data).toEqual({ phone: PHONE, verified: true });
    expect(accounts.docs[0]).toMatchObject({ phone: PHONE, phoneE164: PHONE, phoneVerified: true });
    // single use
    await expect(svc.verifyCode('u1', 'user', PHONE, code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enforces the 60s resend cooldown per number (429) and does not send twice', async () => {
    const { svc, sent } = make();
    await svc.sendCode('u1', 'user', PHONE);
    await expect(svc.sendCode('u1', 'user', PHONE)).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(1);
  });

  it('allows a resend after the cooldown and invalidates the older code', async () => {
    const { svc, otpModel, sent } = make();
    await svc.sendCode('u1', 'user', PHONE);
    const first = codeOf(sent);
    otpModel.docs[0].lastSentAt = new Date(Date.now() - RESEND_COOLDOWN_MS - 1000);
    await svc.sendCode('u1', 'user', PHONE);
    const second = codeOf(sent);
    expect(sent).toHaveLength(2);
    if (first !== second) await expect(svc.verifyCode('u1', 'user', PHONE, first)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.verifyCode('u1', 'user', PHONE, second)).resolves.toMatchObject({ success: true });
  });

  it('caps sends per number per hour', async () => {
    const { svc, otpModel } = make();
    await svc.sendCode('u1', 'user', PHONE);
    for (let i = 0; i < 4; i++) {
      otpModel.docs[0].lastSentAt = new Date(Date.now() - RESEND_COOLDOWN_MS - 1000);
      await svc.sendCode('u1', 'user', PHONE);
    }
    otpModel.docs[0].lastSentAt = new Date(Date.now() - RESEND_COOLDOWN_MS - 1000);
    await expect(svc.sendCode('u1', 'user', PHONE)).rejects.toMatchObject({ status: 429 });
  });

  it('burns the code after 5 wrong attempts: even the right code then fails', async () => {
    const { svc, sent } = make();
    await svc.sendCode('u1', 'user', PHONE);
    const code = codeOf(sent);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) await expect(svc.verifyCode('u1', 'user', PHONE, wrong)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.verifyCode('u1', 'user', PHONE, code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired code', async () => {
    const { svc, otpModel, sent } = make();
    await svc.sendCode('u1', 'user', PHONE);
    otpModel.docs[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.verifyCode('u1', 'user', PHONE, codeOf(sent))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('only the account that asked for the code can verify it', async () => {
    const { svc, sent } = make({ accounts: [{ _id: 'u1', isDelete: false, status: 'active' }, { _id: 'u2', isDelete: false, status: 'active' }] });
    await svc.sendCode('u1', 'user', PHONE);
    await expect(svc.verifyCode('u2', 'user', PHONE, codeOf(sent))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('no enumeration', () => {
    it('gives the same response for a number already verified by another account, but sends nothing and verify fails generically', async () => {
      const taken = { _id: 'u9', isDelete: false, status: 'active', phoneE164: PHONE, phoneVerified: true };
      const a = make({ accounts: [{ _id: 'u1', isDelete: false, status: 'active' }, taken] });
      const free = make();
      const resTaken = await a.svc.sendCode('u1', 'user', PHONE);
      const resFree = await free.svc.sendCode('u1', 'user', PHONE);
      expect(resTaken).toEqual(resFree);
      expect(a.sent).toHaveLength(0);
      expect(free.sent).toHaveLength(1);
      // throttle bookkeeping is identical, so a second request is refused the same way for both
      await expect(a.svc.sendCode('u1', 'user', PHONE)).rejects.toMatchObject({ status: 429 });
      await expect(free.svc.sendCode('u1', 'user', PHONE)).rejects.toMatchObject({ status: 429 });
      // and a guessed code fails with the one generic message
      const err: any = await a.svc.verifyCode('u1', 'user', PHONE, '123456').catch((e) => e);
      const err2: any = await free.svc.verifyCode('u1', 'user', PHONE, '000000').catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe(err2.message);
      expect(a.accounts.docs[0].phoneVerified).toBeUndefined();
    });

    it('does not re-send for the number the account already verified', async () => {
      const { svc, sent } = make({ accounts: [{ _id: 'u1', isDelete: false, status: 'active', phoneE164: PHONE, phoneVerified: true }] });
      const res = await svc.sendCode('u1', 'user', PHONE);
      expect(res.success).toBe(true);
      expect(sent).toHaveLength(0);
    });
  });

  it('a delivery failure returns 503 and does not leave a usable code behind', async () => {
    const { svc, otpModel } = make({ sendOk: false });
    await expect(svc.sendCode('u1', 'user', PHONE)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(otpModel.docs[0].codeHash).toBeNull();
  });

  it('refuses a suspended or unknown account', async () => {
    const { svc } = make({ accounts: [{ _id: 'u1', isDelete: false, status: 'suspended' }] });
    await expect(svc.sendCode('u1', 'user', PHONE)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(make().svc.sendCode('ghost', 'user', PHONE)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throttles a single account asking for codes for many numbers', async () => {
    const { svc } = make();
    for (let i = 0; i < 5; i++) await svc.sendCode('u1', 'user', `+92300123456${i}`);
    const err: any = await svc.sendCode('u1', 'user', '+923001234569').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
  });
});
