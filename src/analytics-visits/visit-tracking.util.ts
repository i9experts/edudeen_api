/* eslint-disable prettier/prettier */
import { createHash } from 'crypto';

/** Where a visit came from. The web classifies document.referrer + utm_*; the server only accepts this list. */
export const VISIT_SOURCES = ['edudeen_search', 'category', 'direct', 'social', 'external'] as const;
export type VisitSource = (typeof VISIT_SOURCES)[number];

export const VISIT_DEDUPE_SECONDS = 30 * 60;
export const COUNTER_TTL_SECONDS = 3 * 24 * 3600; // safety net: a counter the rollup never flushed disappears after 3 days
export const MAX_TERM_LENGTH = 40;

const PKT_OFFSET_MS = 5 * 3600 * 1000;
const HEX24 = /^[0-9a-f]{24}$/;

/** Crawlers, monitors and scripts. An empty user agent counts as a bot too. */
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|pingdom|uptime|monitor|python-requests|python-urllib|curl\/|wget|httpclient|okhttp|scrapy|go-http-client|java\/|axios\/|node-fetch|postman|phantomjs|puppeteer|playwright/i;

export function isBotUserAgent(ua: unknown): boolean {
  if (typeof ua !== 'string') return true;
  const s = ua.trim();
  if (s.length < 10) return true;
  return BOT_UA.test(s);
}

export function isHex24(v: unknown): v is string {
  return typeof v === 'string' && HEX24.test(v);
}

export function sanitizeSource(v: unknown): VisitSource {
  return (VISIT_SOURCES as readonly string[]).includes(v as string) ? (v as VisitSource) : 'direct';
}

/** Search words that led to a store/product: lower-case, letters/digits/space only (Urdu ok), short. Anything else -> null. */
export function sanitizeTerm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH).trim();
  if (t.length < 2) return null;
  if (/\d{6,}/.test(t) || /\S+@\S+/.test(v)) return null; // long numbers / e-mail addresses are never kept
  return t;
}

/** Pakistan calendar day, YYYY-MM-DD. */
export function pktDateOf(d: Date): string {
  return new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** First instant of a PKT calendar day. */
export function pktDayStartOf(pktDate: string): Date {
  return new Date(Date.parse(`${pktDate}T00:00:00.000Z`) - PKT_OFFSET_MS);
}

/** Daily-rotating anonymous session id. Never stored in Mongo, never logged; only used inside Redis keys. */
export function sessionHash(ip: string, ua: string, pktDate: string, secret: string): string {
  return createHash('sha256').update(`${ip}|${ua}|${pktDate}|${secret}`).digest('hex').slice(0, 32);
}

export function visitSecret(): string {
  return process.env.VISIT_HASH_SECRET || process.env.PAYOUT_ENCRYPTION_KEY || process.env.SEO_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || 'edudeen-visits';
}

// ── Redis key layout ──────────────────────────────────────────────────────
export const dedupeKey = (hash: string, kind: 'store' | 'product', id: string) => `av:d:${hash}:${kind}:${id}`;
/** counter: av:c:<pktDate>:<storeId>:<productId|->:<source> */
export const counterKey = (pktDate: string, storeId: string, productId: string | null, source: VisitSource) => `av:c:${pktDate}:${storeId}:${productId ?? '-'}:${source}`;
/** term counter: av:t:<pktDate>:<storeId>:<base64url(term)> */
export const termKey = (pktDate: string, storeId: string, term: string) => `av:t:${pktDate}:${storeId}:${Buffer.from(term, 'utf8').toString('base64url')}`;

export type ParsedCounter = { pktDate: string; storeId: string; productId: string | null; source: VisitSource };
export function parseCounterKey(key: string): ParsedCounter | null {
  const p = key.split(':');
  if (p.length !== 6 || p[0] !== 'av' || p[1] !== 'c') return null;
  const [, , pktDate, storeId, prod, source] = p;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pktDate) || !isHex24(storeId)) return null;
  if (prod !== '-' && !isHex24(prod)) return null;
  if (!(VISIT_SOURCES as readonly string[]).includes(source)) return null;
  return { pktDate, storeId, productId: prod === '-' ? null : prod, source: source as VisitSource };
}

export type ParsedTerm = { pktDate: string; storeId: string; term: string };
export function parseTermKey(key: string): ParsedTerm | null {
  const p = key.split(':');
  if (p.length !== 5 || p[0] !== 'av' || p[1] !== 't') return null;
  const [, , pktDate, storeId, enc] = p;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pktDate) || !isHex24(storeId)) return null;
  const term = sanitizeTerm(Buffer.from(enc, 'base64url').toString('utf8'));
  return term ? { pktDate, storeId, term } : null;
}

// ── Numbers ───────────────────────────────────────────────────────────────
/** Paid non-free orders / visits, in %, 2 decimals. No visits -> null (never a divide-by-zero, never "0%" for unknown). Capped at 100. */
export function conversionRate(paidOrders: number, visits: number): number | null {
  if (!Number.isFinite(visits) || visits <= 0) return null;
  const pct = (Math.max(0, paidOrders) / visits) * 100;
  return Math.round(Math.min(100, pct) * 100) / 100;
}
