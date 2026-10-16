/** Helpers for the admin-editable homepage content (store links, stats thresholds, Urdu copy). */

/** A store link is public only when it is an https URL and not an internal-test / beta link. */
export function isPublicStoreUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (!/^https:\/\/\S+$/i.test(v)) return false;
  return !/internaltest|testflight|internal-test|\/apps\/testing\//i.test(v);
}

/** Below these totals the homepage hides the numbers and shows plain trust points instead. */
export const DEFAULT_STATS_THRESHOLDS = { sellers: 50, buyers: 500, products: 100 } as const;
export type StatsThresholds = { sellers: number; buyers: number; products: number };

const clampInt = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1_000_000, Math.max(0, Math.floor(n)));
};

/** Whole numbers 0..1,000,000; anything missing/invalid falls back to the default. */
export function sanitizeStatsThresholds(raw: unknown): StatsThresholds {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    sellers: clampInt(src.sellers, DEFAULT_STATS_THRESHOLDS.sellers),
    buyers: clampInt(src.buyers, DEFAULT_STATS_THRESHOLDS.buyers),
    products: clampInt(src.products, DEFAULT_STATS_THRESHOLDS.products),
  };
}

/** Text keys of homeContent that may carry an Urdu version (`homeContent.ur.<key>`). */
export const HOME_URDU_KEYS = [
  'heroEyebrow', 'heroTitle', 'heroHighlight', 'heroText', 'heroPrimaryLabel', 'heroSecondaryLabel', 'heroBadge',
  'featureEyebrow', 'featureHeading', 'featureText', 'featureLinkLabel',
  'creatorEyebrow', 'creatorHeading', 'creatorText', 'creatorLinkLabel',
] as const;

/** Keeps only known keys, trimmed and length-capped; blanks are dropped. */
export function sanitizeHomeUrdu(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of HOME_URDU_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 300);
  }
  return out;
}

/** Footer / support contact details shown on the public site. Every field is optional; blank = hidden. */
export interface HomeContact { phone: string; whatsapp: string; address: string; email: string }

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

/** Trimmed, length-capped, markup-free contact block. A malformed email is dropped; phone/WhatsApp keep digits, + and separators only. */
export function sanitizeHomeContact(raw: unknown): HomeContact {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const phoneLike = (v: unknown) => text(v, 30).replace(/[^\d+\-\s()]/g, '').trim();
  const email = text(src.email, 120).toLowerCase();
  return {
    phone: phoneLike(src.phone),
    whatsapp: phoneLike(src.whatsapp),
    address: text(src.address, 300),
    email: EMAIL_RE.test(email) ? email : '',
  };
}

/** Public view of the stored homeContent: a stored internal-test link is never exposed. */
export function publicHomeContent(stored: Record<string, any> | null | undefined): Record<string, any> {
  const hc: Record<string, any> = { ...(stored ?? {}) };
  for (const key of ['googlePlayUrl', 'appStoreUrl']) {
    if (hc[key] && !isPublicStoreUrl(hc[key])) hc[key] = '';
  }
  hc.statsThresholds = sanitizeStatsThresholds(hc.statsThresholds);
  hc.contact = sanitizeHomeContact(hc.contact);
  return hc;
}
