/* eslint-disable prettier/prettier */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — works with Google Authenticator, Authy, 1Password, Microsoft Authenticator. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secret: string, timeMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** The 30-second step a code belongs to (current or one either side for clock drift), or null if it is wrong. Used to stop a code being used twice. */
export function matchTotpStep(secret: string, code: string, now = Date.now()): number | null {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  for (const d of [0, -1, 1]) {
    const expected = Buffer.from(totpAt(secret, now + d * 30_000));
    const given = Buffer.from(clean);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return Math.floor((now + d * 30_000) / 30_000);
  }
  return null;
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  return [-1, 0, 1].some((d) => {
    const expected = Buffer.from(totpAt(secret, now + d * 30_000));
    const given = Buffer.from(clean);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

export const otpauthUrl = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Edudeen Admin:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('Edudeen Admin')}&algorithm=SHA1&digits=6&period=30`;
