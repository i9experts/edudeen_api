/* eslint-disable prettier/prettier */
import { createHmac, randomInt, timingSafeEqual } from 'crypto';

// Pure logic for phone/WhatsApp OTP verification (no Nest/Mongo) so it can be unit-tested thoroughly.

export const OTP_TTL_MS = 5 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_VERIFY_ATTEMPTS = 5;
export const MAX_SENDS_PER_HOUR = 5;
export const HOUR_MS = 60 * 60 * 1000;

/**
 * Normalises a phone number to E.164. Accepts Pakistani mobiles in local form
 * (0300 1234567, 300-1234567, 923001234567, 0092 300 1234567) and any international
 * number written with a leading + or 00. Returns null for anything that is not a plausible mobile number.
 * Pakistan (+92) numbers must be mobiles (3xx xxxxxxx), because OTP goes over WhatsApp/SMS.
 */
export function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 25) return null;
  if (!/^[+\d\s().-]+$/.test(s)) return null; // letters etc. are rejected outright
  if (s.indexOf('+') > 0 || (s.match(/\+/g) ?? []).length > 1) return null;
  let d = s.replace(/\D/g, '');
  let international = s.startsWith('+');
  if (!international && d.startsWith('00')) { d = d.slice(2); international = true; }

  if (!international) {
    // Local Pakistani forms.
    if (/^03\d{9}$/.test(d)) d = `92${d.slice(1)}`;
    else if (/^3\d{9}$/.test(d)) d = `92${d}`;
    else if (/^92\d{10}$/.test(d)) { /* already country-coded, written without + */ }
    else return null;
  }
  if (!/^[1-9]\d{7,14}$/.test(d)) return null;
  if (d.startsWith('92') && !/^923\d{9}$/.test(d)) return null;
  return `+${d}`;
}

/** True when saving `newPhone` on an account whose verified number is `verifiedE164` must drop the verified flag. */
export function phoneChangeInvalidatesVerification(verifiedE164: string | null | undefined, newPhone: unknown): boolean {
  if (!verifiedE164) return false;
  return normalizeE164(newPhone) !== verifiedE164;
}

export function generatePhoneOtp(): string {
  return randomInt(100000, 1000000).toString();
}

/** Same scheme as the email OTP (HMAC-SHA256 keyed with JWT_SECRET) but bound to the number, so a code is useless for another number. */
export function hashPhoneOtp(phone: string, otp: string, secret = process.env.JWT_SECRET ?? ''): string {
  return createHmac('sha256', secret).update(`phone:${phone}:${String(otp ?? '')}`).digest('hex');
}

export interface PhoneOtpState {
  codeHash: string | null;
  expiresAt: Date | null;
  attempts: number;
  lastSentAt: Date | null;
  windowStart: Date | null;
  sendCount: number;
}

export type SendDecision =
  | { allowed: true; windowStart: Date; sendCount: number }
  | { allowed: false; reason: 'cooldown' | 'hourly_limit'; retryAfterSec: number };

/** Resend cooldown (60s) and a per-number hourly cap (5 sends), both on the NUMBER so one victim number cannot be spammed. */
export function evaluateSend(state: PhoneOtpState | null, now: Date = new Date()): SendDecision {
  if (state?.lastSentAt) {
    const since = now.getTime() - state.lastSentAt.getTime();
    if (since < RESEND_COOLDOWN_MS) return { allowed: false, reason: 'cooldown', retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - since) / 1000) };
  }
  const windowOpen = !!state?.windowStart && now.getTime() - state.windowStart.getTime() < HOUR_MS;
  const sendCount = windowOpen ? state!.sendCount : 0;
  if (windowOpen && sendCount >= MAX_SENDS_PER_HOUR) {
    return { allowed: false, reason: 'hourly_limit', retryAfterSec: Math.ceil((HOUR_MS - (now.getTime() - state!.windowStart!.getTime())) / 1000) };
  }
  return { allowed: true, windowStart: windowOpen ? state!.windowStart! : now, sendCount: sendCount + 1 };
}

export type VerifyDecision =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'locked' | 'wrong'; /** the stored code must be burned */ burn: boolean };

/** Constant-time comparison; burns the code after MAX_VERIFY_ATTEMPTS wrong tries. The caller maps every failure to ONE generic message. */
export function evaluateVerify(state: PhoneOtpState | null, phone: string, otp: unknown, now: Date = new Date(), secret?: string): VerifyDecision {
  if (!state?.codeHash) return { ok: false, reason: 'no_code', burn: false };
  if (!state.expiresAt || now.getTime() > state.expiresAt.getTime()) return { ok: false, reason: 'expired', burn: true };
  if ((state.attempts ?? 0) >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'locked', burn: true };
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) return { ok: false, reason: 'wrong', burn: (state.attempts ?? 0) + 1 >= MAX_VERIFY_ATTEMPTS };
  const a = Buffer.from(hashPhoneOtp(phone, otp.trim(), secret));
  const b = Buffer.from(state.codeHash);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) return { ok: true };
  return { ok: false, reason: 'wrong', burn: (state.attempts ?? 0) + 1 >= MAX_VERIFY_ATTEMPTS };
}
