/* eslint-disable prettier/prettier */
/** Where and when a staff member may use the admin panel (both optional; empty = no restriction). */
export interface WorkHours { days: number[]; from: string; to: string; tz?: string }

export const DEFAULT_TZ = 'Asia/Karachi';

export function normalizeIp(ip?: string | null): string {
  return String(ip ?? '').trim().replace(/^::ffff:/i, '');
}

const ipv4ToInt = (ip: string): number | null => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null;
};

/** Exact address, or an IPv4 range like 203.0.113.0/24. */
export function ipMatches(rule: string, ip: string): boolean {
  const r = rule.trim();
  if (!r) return false;
  if (!r.includes('/')) return normalizeIp(r) === ip;
  const [base, bitsRaw] = r.split('/');
  const bits = Number(bitsRaw), a = ipv4ToInt(base), b = ipv4ToInt(ip);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export const sanitizeIps = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.map((x) => String(x ?? '').trim()).filter((x) => x && x.length <= 64 && /^[0-9a-fA-F:.\/]+$/.test(x)))].slice(0, 20) : [];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function sanitizeWorkHours(raw: any): WorkHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))] as number[] : [];
  if (!days.length || !HHMM.test(String(raw.from)) || !HHMM.test(String(raw.to))) return null;
  let tz = String(raw.tz || DEFAULT_TZ);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = DEFAULT_TZ; }
  return { days, from: String(raw.from), to: String(raw.to), tz };
}

const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function localParts(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: DAY[get('weekday')] ?? 0, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** A human reason when this sign-in / request is outside the allowed IPs or hours; null when fine. */
export function accessWindowViolation(a: { allowedIps?: string[]; workHours?: WorkHours | null }, ip: string | undefined, now = new Date()): string | null {
  const ips = a.allowedIps ?? [];
  if (ips.length) {
    const cur = normalizeIp(ip);
    if (!cur || !ips.some((r) => ipMatches(r, cur))) return 'You can only sign in from your approved network. Contact the owner.';
  }
  const w = a.workHours;
  if (w?.days?.length) {
    const { day, minutes } = localParts(now, w.tz || DEFAULT_TZ);
    const from = toMin(w.from), to = toMin(w.to);
    const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to; // overnight shifts
    if (!w.days.includes(day) || !inside) return `Your access is limited to ${w.from}–${w.to} on your working days. Try again during your hours.`;
  }
  return null;
}
