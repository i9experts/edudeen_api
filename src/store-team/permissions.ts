/* eslint-disable prettier/prettier */
import { normalizeRequestPath } from '../common/request-path.util';

/**
 * Store team ("collaborators"): rights a store owner can give another person for ONE store.
 * A member works through a store-locked seller token (actAs:'collaborator'); `store-team/member-access.middleware`
 * enforces everything below on every request.
 *
 * Model: reads are allowed (the panel needs them) EXCEPT the owner-only areas. A WRITE needs a mapped permission:
 * an unmapped write is refused (fail closed), so a new route is never silently open to members.
 */
export interface StorePermission { key: string; label: string }

export const STORE_PERMISSIONS: StorePermission[] = [
  { key: 'products.manage', label: 'Add, edit and remove products, inventory, collections and bundles' },
  { key: 'orders.manage', label: 'Process orders, shipping and cancellations' },
  { key: 'returns.manage', label: 'Handle returns and refund requests' },
  { key: 'support.manage', label: 'Reply to messages, questions and reviews' },
  { key: 'marketing.manage', label: 'Coupons, discounts, banners, sales and AI tools' },
  { key: 'storefront.manage', label: 'Store page, theme, pages and store settings' },
];
export const STORE_PERMISSION_KEYS = new Set(STORE_PERMISSIONS.map((p) => p.key));

export interface StoreRoleTemplate { key: string; name: string; description: string; permissions: string[] }
export const STORE_ROLE_TEMPLATES: StoreRoleTemplate[] = [
  { key: 'manager', name: 'Manager', description: 'Everything except money, plan, team and account settings.', permissions: ['products.manage', 'orders.manage', 'returns.manage', 'support.manage', 'marketing.manage', 'storefront.manage'] },
  { key: 'product_editor', name: 'Product editor', description: 'Products, inventory and the store page.', permissions: ['products.manage', 'storefront.manage'] },
  { key: 'order_handler', name: 'Order handler', description: 'Orders, shipping and returns.', permissions: ['orders.manage', 'returns.manage'] },
  { key: 'support', name: 'Support', description: 'Messages, questions and reviews.', permissions: ['support.manage'] },
  { key: 'viewer', name: 'Viewer', description: 'Can look around, cannot change anything.', permissions: [] },
];

export function roleTemplate(key: string): StoreRoleTemplate | undefined {
  return STORE_ROLE_TEMPLATES.find((r) => r.key === key);
}

/** Effective rights = template + extras - removals, limited to known keys. */
export function effectiveStorePermissions(roleKey: string, add: string[] = [], remove: string[] = []): Set<string> {
  const set = new Set<string>(roleTemplate(roleKey)?.permissions ?? []);
  for (const k of add) if (STORE_PERMISSION_KEYS.has(k)) set.add(k);
  for (const k of remove) set.delete(k);
  return set;
}

export function sanitizeStorePermissions(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return Array.from(new Set(list.filter((k): k is string => typeof k === 'string' && STORE_PERMISSION_KEYS.has(k))));
}

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

/** OWNER-ONLY: refused for every member, every method (reads included), whatever the role. */
// `writesOnly`: the panel itself reads these (plan banner, profile avatar), so only changes are refused.
const OWNER_ONLY: { re: RegExp; reason: string; except?: RegExp; writesOnly?: boolean }[] = [
  { re: /^\/api\/finance(\/|$)/, reason: 'Earnings, payouts and payout methods are for the store owner only.' },
  { re: /^\/api\/stripe-connect(\/|$)/, writesOnly: true, reason: 'Payment account setup is for the store owner only.' },
  { re: /^\/api\/platform-plans(\/|$)/, writesOnly: true, reason: 'Plan and billing are for the store owner only.' },
  { re: /^\/api\/users(\/|$)/, writesOnly: true, reason: 'Account settings are for the store owner only.' },
  { re: /^\/api\/auth(\/|$)/, writesOnly: true, except: /^\/api\/auth\/logout$/, reason: 'Account settings are for the store owner only.' },
  { re: /^\/api\/store-team\/[0-9a-f]{24}(\/|$)/, reason: 'Team management is for the store owner only.' },
  { re: /^\/api\/orders\/mark-paid(\/|$)/, reason: 'Confirming cash payments is for the store owner only.' },
  { re: /^\/api\/store\/[^/]+\/(custom-domain|white-label)$/, writesOnly: true, reason: 'Domain and branding settings are for the store owner only.' },
];

interface Rule { re: RegExp; perm: string }
/** Writes (non-GET). First match wins. */
const WRITE_RULES: Rule[] = [
  { re: /^\/api\/(refund-request|orders\/return-action|orders\/return-follow-up)(\/|$)/, perm: 'returns.manage' },
  { re: /^\/api\/(orders|couriers)(\/|$)/, perm: 'orders.manage' },
  { re: /^\/api\/(products|inventory|collections|bundles|categories|upload|courses|media-library)(\/|$)/, perm: 'products.manage' },
  { re: /^\/api\/(messaging|rating|product-questions|questions)(\/|$)/, perm: 'support.manage' },
  { re: /^\/api\/(marketing|seller\/marketing|promotions|banners|store-banner|gift-cards|loyalty|ai-studio|ai\/seller|seller\/promotions)(\/|$)/, perm: 'marketing.manage' },
  { re: /^\/api\/store\/[^/]+\/seo(\/|$)/, perm: 'marketing.manage' },
  { re: /^\/api\/store\/[^/]+\/customers(\/|$)/, perm: 'support.manage' },
  { re: /^\/api\/(store-theme|store-pages|store|seo)(\/|$)/, perm: 'storefront.manage' },
];

/**
 * What a member needs for this request:
 *  - `{ denied: reason }` owner-only area (or no member route exists for this write),
 *  - `{ need: key }`      this permission,
 *  - `{ need: null }`     allowed for any member (a read, or a harmless member-self call).
 */
export function memberRequirement(method: string, rawPath: string): { denied?: string; need?: string | null } {
  const path = normalizeRequestPath(rawPath);
  if (path === null) return { denied: 'Invalid request path.' };
  const m = String(method || 'GET').toUpperCase();
  for (const o of OWNER_ONLY) {
    if (!o.re.test(path) || o.except?.test(path)) continue;
    if (o.writesOnly && READ.has(m)) continue;
    return { denied: o.reason };
  }
  // A DELETE of the whole store is never a member action.
  if (m === 'DELETE' && /^\/api\/store\/[^/]+$/.test(path)) return { denied: 'Deleting a store is for the store owner only.' };
  if (READ.has(m)) return { need: null };
  // Member-self calls (leave the session) and notification housekeeping are open to every member.
  if (/^\/api\/(auth\/logout|notifications)(\/|$)/.test(path)) return { need: null };
  if (/^\/api\/store-team\/(switch|mine)$/.test(path)) return { need: null };
  for (const r of WRITE_RULES) if (r.re.test(path)) return { need: r.perm };
  return { denied: 'Your role cannot do this.' };
}
