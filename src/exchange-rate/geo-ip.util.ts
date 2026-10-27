import { isIP } from 'net';
import { normalizeCountry } from './country-currency.util';

// Country of a visitor's IP for hosts with no CDN country header (Railway sends none). Free keyless
// lookup (api.country.is, ISO code only), cached per IP; any failure -> null (the web then uses the
// browser's own hint). Only the visitor's IP leaves the server, nothing else.

const TTL_MS = 24 * 3600_000;
const FAIL_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 5000;
const cache = new Map<string, { country: string | null; until: number }>();

export function isPublicIp(ip: string): boolean {
  if (!isIP(ip)) return false;
  if (ip.includes(':')) return !/^(::1|fc|fd|fe80)/i.test(ip) && !ip.startsWith('::ffff:127.');
  const [a, b] = ip.split('.').map(Number);
  return !(a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
}

/** First public client IP from X-Forwarded-For / req.ip (IPv4-mapped IPv6 unwrapped). */
export function clientIpOf(req: { ip?: string; headers?: Record<string, unknown> }): string | null {
  const xff = req.headers?.['x-forwarded-for'];
  const raw = [typeof xff === 'string' ? xff.split(',')[0] : '', req.ip ?? ''].map(s => s.trim().replace(/^::ffff:/, ''));
  return raw.find(isPublicIp) ?? null;
}

export async function countryFromIp(ip: string | null, now = Date.now()): Promise<string | null> {
  if (!ip) return null;
  const hit = cache.get(ip);
  if (hit && hit.until > now) return hit.country;
  let country: string | null = null;
  try {
    const res = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) country = normalizeCountry(((await res.json()) as any)?.country);
  } catch { /* lookup is best effort */ }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(ip, { country, until: now + (country ? TTL_MS : FAIL_TTL_MS) });
  return country;
}
