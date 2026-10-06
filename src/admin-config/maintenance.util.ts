/** Maintenance mode: WHAT is down and WHY, so the platform can block only the affected area and tell users plainly. */
export const MAINTENANCE_SCOPES = ['all', 'buyer', 'seller', 'checkout', 'uploads'] as const;
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];

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
  updatedAt: Date | null;
}

export const DEFAULT_MAINTENANCE: MaintenanceSettings = {
  enabled: false, scopes: ['all'], type: 'scheduled_upgrade', title: '', message: '',
  startsAt: null, endsAt: null, statusNote: '', updatedAt: null,
};

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
const EXEMPT = [/^\/api\/admin(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/platform-config(\/|$)/, /webhook/i, /^\/api\/health/, /^\/health/];

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

export function blockedByMaintenance(m: MaintenanceSettings, method: string, path: string, now = new Date()): boolean {
  if (maintenanceState(m, now) !== 'active') return false;
  const area = areaOfRequest(method, path);
  if (!area) return false;
  return m.scopes.includes('all') || m.scopes.includes(area);
}
