/** Maintenance mode: WHAT is down and WHY, so the platform can block only the affected area and tell users plainly. */
export const BASE_MAINTENANCE_SCOPES = ['all', 'buyer', 'seller', 'checkout', 'uploads'] as const;

/**
 * Single features / pages an admin can take down on their own (e.g. just the
 * flash sale). `apiPatterns` is what the server blocks; the web app shows the
 * admin's message in place of that page or section.
 */
export const MAINTENANCE_FEATURES = {
  flash_sale:   { apiPatterns: [/^\/api\/public\/marketing\//, /^\/api\/marketing\/[^/]+\/campaigns/] },
  search:       { apiPatterns: [/^\/api\/search\/(products|trending)/] },
  categories:   { apiPatterns: [/^\/api\/categories(\/|$)/, /^\/api\/products\/products-by-category/] },
  product_page: { apiPatterns: [/^\/api\/products\/(getProductById|getVariantById|preview|sample|also-bought)/] },
  cart:         { apiPatterns: [/^\/api\/cart(\/|$)/] },
  reviews:      { apiPatterns: [/^\/api\/rating(\/|$)/] },
  messaging:    { apiPatterns: [/^\/api\/messaging(\/|$)/] },
  stores:       { apiPatterns: [/^\/api\/search\/stores/, /^\/api\/store\/(getStoreById|public)/] },
  learn:        { apiPatterns: [/^\/api\/products\/education(\/|$)/] },
  orders:       { apiPatterns: [/^\/api\/orders(\/|$)/] },
} as const;
export type MaintenanceFeature = keyof typeof MAINTENANCE_FEATURES;
const FEATURE_KEYS = Object.keys(MAINTENANCE_FEATURES) as MaintenanceFeature[];

export type FeatureScope = `feature:${MaintenanceFeature}`;
export type MaintenanceScope = (typeof BASE_MAINTENANCE_SCOPES)[number] | FeatureScope;
export const MAINTENANCE_SCOPES: readonly MaintenanceScope[] = [
  ...BASE_MAINTENANCE_SCOPES,
  ...FEATURE_KEYS.map((k) => `feature:${k}` as FeatureScope),
];

export const MAINTENANCE_TYPES = ['scheduled_upgrade', 'database', 'payments', 'security', 'performance', 'emergency', 'other'] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export interface MaintenanceSettings {
  /** Armed. Takes effect at `startsAt` if that is in the future, otherwise immediately. */
  enabled: boolean;
  scopes: MaintenanceScope[];
  type: MaintenanceType;
  title: string;
  message: string;
  startsAt: Date | null;
  /** Estimated finish — shown to users; it never switches maintenance off by itself. */
  endsAt: Date | null;
  /** Live progress line, e.g. "Database migration 60% done". */
  statusNote: string;
  /** Optional own headline/message for a selected scope (keyed by scope, e.g. "feature:search"); falls back to title/message. */
  scopeMessages: Record<string, { title: string; message: string }>;
  updatedAt: Date | null;
}

export const DEFAULT_MAINTENANCE: MaintenanceSettings = {
  enabled: false, scopes: ['all'], type: 'scheduled_upgrade', title: '', message: '',
  startsAt: null, endsAt: null, statusNote: '', scopeMessages: {}, updatedAt: null,
};

/** Keeps only known scopes and trims text, so a bad client payload can't store junk. */
export function cleanScopeMessages(raw: any): Record<string, { title: string; message: string }> {
  const out: Record<string, { title: string; message: string }> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (!MAINTENANCE_SCOPES.includes(k as MaintenanceScope) || !v || typeof v !== 'object') continue;
    const title = typeof v.title === 'string' ? v.title.trim().slice(0, 120) : '';
    const message = typeof v.message === 'string' ? v.message.trim().slice(0, 1000) : '';
    if (title || message) out[k] = { title, message };
  }
  return out;
}

export function normalizeMaintenance(raw: any, legacyFlag?: boolean): MaintenanceSettings {
  const m = raw && typeof raw === 'object' ? raw : {};
  const scopes = Array.isArray(m.scopes) ? m.scopes.filter((s: any) => MAINTENANCE_SCOPES.includes(s)) : [];
  return {
    enabled: typeof m.enabled === 'boolean' ? m.enabled : legacyFlag === true,
    scopes: scopes.length ? scopes : ['all'],
    type: MAINTENANCE_TYPES.includes(m.type) ? m.type : 'scheduled_upgrade',
    title: typeof m.title === 'string' ? m.title : '',
    message: typeof m.message === 'string' ? m.message : '',
    startsAt: m.startsAt ? new Date(m.startsAt) : null,
    endsAt: m.endsAt ? new Date(m.endsAt) : null,
    statusNote: typeof m.statusNote === 'string' ? m.statusNote : '',
    scopeMessages: cleanScopeMessages(m.scopeMessages),
    updatedAt: m.updatedAt ? new Date(m.updatedAt) : null,
  };
}

/** 'active' = blocking now, 'scheduled' = armed for a future start (banner only), 'off'. */
export function maintenanceState(m: MaintenanceSettings, now = new Date()): 'active' | 'scheduled' | 'off' {
  if (!m.enabled) return 'off';
  if (m.startsAt && m.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'active';
}

/** Never blocked: admin tools and sign-in (so admins can switch maintenance off), the status endpoint, and payment webhooks (blocking those loses money). */
const EXEMPT = [/^\/api\/admin(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/platform-config(\/|$)/, /webhook/i, /^\/api\/payment\/pk\/[a-z]+\/callback/i, /^\/api\/health/, /^\/health/];

export type RequestArea = 'checkout' | 'uploads' | 'seller' | 'buyer';

/** Which part of the platform a request belongs to; null = never blocked. */
export function areaOfRequest(method: string, path: string): RequestArea | null {
  if (!path.startsWith('/api/') || EXEMPT.some((r) => r.test(path))) return null;
  if (/^\/api\/(checkout|payment)(\/|$)/.test(path)) return 'checkout';
  if (/^\/api\/upload(\/|$)/.test(path)) return 'uploads';
  const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (/^\/api\/(finance|promotions|marketing|ai-studio|seller|store-banner|shipping|inventory|loyalty)(\/|$)/.test(path)) return 'seller';
  if (write && /^\/api\/(store|products|collections|bundles)(\/|$)/.test(path)) return 'seller';
  return 'buyer';
}

/** Features whose API this request belongs to (a request can match several). */
export function featuresOfRequest(path: string): MaintenanceFeature[] {
  return FEATURE_KEYS.filter((k) => MAINTENANCE_FEATURES[k].apiPatterns.some((r) => r.test(path)));
}

/** What blocks this request — 'all', an area, or "feature:x" — or null if it passes. */
export function blockingScope(m: MaintenanceSettings, method: string, path: string, now = new Date()): string | null {
  if (maintenanceState(m, now) !== 'active') return null;
  const area = areaOfRequest(method, path);
  if (!area) return null;
  if (m.scopes.includes('all')) return 'all';
  if (m.scopes.includes(area)) return area;
  const hit = featuresOfRequest(path).find((f) => m.scopes.includes(`feature:${f}`));
  return hit ? `feature:${hit}` : null;
}

export function blockedByMaintenance(m: MaintenanceSettings, method: string, path: string, now = new Date()): boolean {
  return blockingScope(m, method, path, now) !== null;
}
