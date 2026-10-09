import {
  HOUR_MS, MAX_SENDS_PER_HOUR, MAX_VERIFY_ATTEMPTS, OTP_TTL_MS, RESEND_COOLDOWN_MS, evaluateSend, evaluateVerify, generatePhoneOtp,
  hashPhoneOtp, normalizeE164, phoneChangeInvalidatesVerification, type PhoneOtpState,
} from './phone-otp.util';

describe('normalizeE164', () => {
  it.each([
    ['03001234567', '+923001234567'],
    ['0300 1234567', '+923001234567'],
    ['0300-123-4567', '+923001234567'],
    ['3001234567', '+923001234567'],
    ['923001234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['+92(300)1234567', '+923001234567'],
    ['0092 300 1234567', '+923001234567'],
    ['+447911123456', '+447911123456'],
    ['+1 415 555 2671', '+14155552671'],
    ['  03451234567  ', '+923451234567'],
  ])('accepts %s', (input, expected) => expect(normalizeE164(input)).toBe(expected));

  it.each([
    [''], ['   '], ['abc'], ['0300ABC4567'], ['12345'], ['0300123456'], ['030012345678'], ['+92 21 1234567'], ['+920300123456'],
    ['+0300123456'], ['++923001234567'], ['92+3001234567'], ['03001234567; DROP'], ['+1234567'], ['+1234567890123456'], ['0212345678'],
  ])('rejects %p', (input) => expect(normalizeE164(input)).toBeNull());

  it('rejects non-strings', () => {
    expect(normalizeE164(undefined)).toBeNull();
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164(3001234567)).toBeNull();
    expect(normalizeE164({ $ne: '' })).toBeNull();
  });

  it('is idempotent', () => {
    const once = normalizeE164('0300 1234567')!;
    expect(normalizeE164(once)).toBe(once);
  });
});

describe('otp generation and hashing', () => {
  it('makes 6-digit codes', () => {
    for (let i = 0; i < 200; i++) expect(generatePhoneOtp()).toMatch(/^[1-9]\d{5}$/);
  });
  it('hashes (never stores plaintext), deterministically, and binds the code to the number and the secret', () => {
    const h = hashPhoneOtp('+923001234567', '123456', 's1');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('123456');
    expect(hashPhoneOtp('+923001234567', '123456', 's1')).toBe(h);
    expect(hashPhoneOtp('+923009999999', '123456', 's1')).not.toBe(h); // a code is useless for another number
    expect(hashPhoneOtp('+923001234567', '123456', 's2')).not.toBe(h);
    expect(hashPhoneOtp('+923001234567', '654321', 's1')).not.toBe(h);
  });
});

describe('evaluateSend (cooldown + hourly cap)', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const at = (ms: number) => new Date(now.getTime() - ms);
  const state = (over: Partial<PhoneOtpState> = {}): PhoneOtpState => ({ codeHash: 'x', expiresAt: at(-OTP_TTL_MS), attempts: 0, lastSentAt: at(2 * RESEND_COOLDOWN_MS), windowStart: at(5 * 60_000), sendCount: 1, ...over });

  it('allows the first send and opens a window', () => {
    expect(evaluateSend(null, now)).toEqual({ allowed: true, windowStart: now, sendCount: 1 });
  });
  it('enforces the 60s resend cooldown and reports the wait', () => {
    const r = evaluateSend(state({ lastSentAt: at(20_000) }), now);
    expect(r).toMatchObject({ allowed: false, reason: 'cooldown' });
    expect((r as any).retryAfterSec).toBe(40);
  });
  it('counts sends inside the hour and blocks the 6th', () => {
    expect(evaluateSend(state({ sendCount: MAX_SENDS_PER_HOUR - 1 }), now)).toMatchObject({ allowed: true, sendCount: MAX_SENDS_PER_HOUR });
    const blocked = evaluateSend(state({ sendCount: MAX_SENDS_PER_HOUR }), now);
    expect(blocked).toMatchObject({ allowed: false, reason: 'hourly_limit' });
    expect((blocked as any).retryAfterSec).toBeGreaterThan(0);
  });
  it('opens a fresh window after an hour', () => {
    const r = evaluateSend(state({ sendCount: MAX_SENDS_PER_HOUR, windowStart: at(HOUR_MS + 1000), lastSentAt: at(HOUR_MS) }), now);
    expect(r).toEqual({ allowed: true, windowStart: now, sendCount: 1 });
  });
});

describe('evaluateVerify', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const phone = '+923001234567';
  const good = (over: Partial<PhoneOtpState> = {}): PhoneOtpState => ({
    codeHash: hashPhoneOtp(phone, '123456', 'k'), expiresAt: new Date(now.getTime() + OTP_TTL_MS), attempts: 0, lastSentAt: now, windowStart: now, sendCount: 1, ...over,
  });

  it('accepts the right code', () => expect(evaluateVerify(good(), phone, '123456', now, 'k')).toEqual({ ok: true }));
  it('accepts surrounding whitespace', () => expect(evaluateVerify(good(), phone, ' 123456 ', now, 'k')).toEqual({ ok: true }));
  it('rejects a wrong code without burning until the last attempt', () => {
    expect(evaluateVerify(good(), phone, '000000', now, 'k')).toEqual({ ok: false, reason: 'wrong', burn: false });
    expect(evaluateVerify(good({ attempts: MAX_VERIFY_ATTEMPTS - 1 }), phone, '000000', now, 'k')).toEqual({ ok: false, reason: 'wrong', burn: true });
  });
  it('locks after MAX attempts even for the right code', () => {
    expect(evaluateVerify(good({ attempts: MAX_VERIFY_ATTEMPTS }), phone, '123456', now, 'k')).toEqual({ ok: false, reason: 'locked', burn: true });
  });
  it('rejects an expired code (5 minutes) even if correct', () => {
    expect(evaluateVerify(good({ expiresAt: new Date(now.getTime() - 1) }), phone, '123456', now, 'k')).toMatchObject({ ok: false, reason: 'expired' });
    expect(evaluateVerify(good({ expiresAt: new Date(now.getTime() + 1) }), phone, '123456', now, 'k')).toEqual({ ok: true });
  });
  it('rejects when there is no code (never sent, burned, or number taken)', () => {
    expect(evaluateVerify(null, phone, '123456', now, 'k')).toMatchObject({ ok: false, reason: 'no_code' });
    expect(evaluateVerify(good({ codeHash: null }), phone, '123456', now, 'k')).toMatchObject({ ok: false, reason: 'no_code' });
  });
  it('rejects the code for a different number, a different secret and malformed input', () => {
    expect(evaluateVerify(good(), '+923009999999', '123456', now, 'k')).toMatchObject({ ok: false });
    expect(evaluateVerify(good(), phone, '123456', now, 'other')).toMatchObject({ ok: false });
    for (const bad of ['12345', '1234567', 'abcdef', '', undefined, null, 123456, { $ne: 1 }]) {
      expect(evaluateVerify(good(), phone, bad as any, now, 'k')).toMatchObject({ ok: false, reason: 'wrong' });
    }
  });
});

describe('phoneChangeInvalidatesVerification', () => {
  it('keeps verification when the same number is saved in another format', () => {
    expect(phoneChangeInvalidatesVerification('+923001234567', '0300 1234567')).toBe(false);
  });
  it('drops it when the number changes or becomes invalid/empty', () => {
    expect(phoneChangeInvalidatesVerification('+923001234567', '0301 1234567')).toBe(true);
    expect(phoneChangeInvalidatesVerification('+923001234567', '')).toBe(true);
    expect(phoneChangeInvalidatesVerification('+923001234567', 'garbage')).toBe(true);
  });
  it('does nothing when no number was verified', () => {
    expect(phoneChangeInvalidatesVerification(null, '0301 1234567')).toBe(false);
  });
});
