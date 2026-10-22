import { normalizeRequestPath } from '../common/request-path.util';
/* eslint-disable prettier/prettier */
/**
 * Staff permissions: what an admin-panel staff member may do.
 * - The OWNER (an admin account that is not flagged `isStaff`) can do everything.
 * - A STAFF account gets: its role's permissions + per-person extras - per-person removals.
 * - Enforced on the server for every request made with a staff token (staff-access.middleware.ts);
 *   anything not covered by a rule is DENIED for /api/admin/*.
 */
export interface PermissionDef { key: string; label: string; group: string; sensitive?: boolean }

export const PERMISSIONS: PermissionDef[] = [
  { key: 'analytics.view', label: 'View analytics & overview', group: 'Insights' },
  { key: 'activity.view', label: 'View the platform activity log', group: 'Insights' },
  { key: 'users.view', label: 'View buyers & sellers', group: 'Users' },
  { key: 'users.manage', label: 'Suspend / unsuspend accounts', group: 'Users', sensitive: true },
  { key: 'marketplace.view', label: 'View listings & stores', group: 'Marketplace' },
  { key: 'marketplace.manage', label: 'Approve, feature or remove listings', group: 'Marketplace' },
  { key: 'stores.approve', label: 'Approve or reject stores', group: 'Marketplace', sensitive: true },
  { key: 'moderation.view', label: 'View reports & flagged content', group: 'Moderation' },
  { key: 'moderation.manage', label: 'Resolve reports, remove reviews', group: 'Moderation' },
  { key: 'orders.view', label: 'View orders & refund requests', group: 'Orders' },
  { key: 'orders.manage', label: 'Update orders', group: 'Orders' },
  { key: 'orders.refund', label: 'Approve or reject refunds', group: 'Orders', sensitive: true },
  { key: 'payments.view', label: 'View payment proofs', group: 'Money' },
  { key: 'payments.approve', label: 'Approve or reject payment proofs', group: 'Money', sensitive: true },
  { key: 'finance.view', label: 'View finance & payouts', group: 'Money' },
  { key: 'finance.manage', label: 'Change fees, FX and commission rules', group: 'Money', sensitive: true },
  { key: 'finance.payouts', label: 'Approve, reject or retry payouts & see bank details', group: 'Money', sensitive: true },
  { key: 'marketing.view', label: 'View campaigns & promotions', group: 'Marketing' },
  { key: 'marketing.manage', label: 'Create campaigns, approve promotions', group: 'Marketing' },
  { key: 'content.view', label: 'View banners & site content', group: 'Content' },
  { key: 'content.manage', label: 'Edit banners, announcements, FAQs, slides', group: 'Content' },
  { key: 'categories.manage', label: 'Manage categories', group: 'Content' },
  { key: 'seo.view', label: 'View SEO tools', group: 'Content' },
  { key: 'seo.manage', label: 'Change SEO settings & redirects', group: 'Content' },
  { key: 'support.view', label: 'Read support chats & messages', group: 'Support' },
  { key: 'support.reply', label: 'Reply to chats, handle reports', group: 'Support' },
  { key: 'ai.manage', label: 'Manage AI Studio settings', group: 'Platform' },
  { key: 'plans.view', label: 'View plans, Premium & subscriptions', group: 'Platform' },
  { key: 'plans.manage', label: 'Edit plans & Premium, refund invoices', group: 'Platform', sensitive: true },
  { key: 'config.view', label: 'View platform settings', group: 'Platform' },
  { key: 'config.manage', label: 'Change platform settings & maintenance', group: 'Platform', sensitive: true },
  { key: 'staff.view', label: 'See the team directory', group: 'Team' },
  { key: 'tasks.assign', label: 'Create and assign tasks', group: 'Team' },
  { key: 'approvals.decide', label: 'Approve or reject other staff members\u0027 sensitive actions', group: 'Team', sensitive: true },
];

/** Never grantable: only the owner can manage staff. */
export const OWNER_ONLY = ['staff.manage'];
export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

export const sanitizePermissions = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((k): k is string => typeof k === 'string' && PERMISSION_KEYS.has(k)))] : [];

const views = PERMISSIONS.map((p) => p.key).filter((k) => k.endsWith('.view'));

export const ROLE_TEMPLATES: { slug: string; name: string; description: string; permissions: string[] }[] = [
  { slug: 'support_agent', name: 'Support Agent', description: 'Answers chats and messages, looks up orders and users. Cannot refund.',
    permissions: ['support.view', 'support.reply', 'orders.view', 'users.view', 'moderation.view', 'staff.view'] },
  { slug: 'catalog_moderator', name: 'Catalog Moderator', description: 'Reviews listings, reports and categories.',
    permissions: ['marketplace.view', 'marketplace.manage', 'moderation.view', 'moderation.manage', 'categories.manage', 'content.view', 'staff.view'] },
  { slug: 'marketing_manager', name: 'Marketing Manager', description: 'Banners, campaigns, flash sale, homepage and SEO.',
    permissions: ['marketing.view', 'marketing.manage', 'content.view', 'content.manage', 'categories.manage', 'seo.view', 'seo.manage', 'analytics.view', 'staff.view'] },
  { slug: 'finance_officer', name: 'Finance Officer', description: 'Payment proofs and payouts. Fee and FX changes are not included.',
    permissions: ['finance.view', 'payments.view', 'payments.approve', 'finance.payouts', 'orders.view', 'plans.view', 'analytics.view', 'staff.view'] },
  { slug: 'content_editor', name: 'Content Editor', description: 'Site content, FAQs, banners and SEO text.',
    permissions: ['content.view', 'content.manage', 'seo.view', 'seo.manage', 'categories.manage', 'staff.view'] },
  { slug: 'analyst', name: 'Analyst (read-only)', description: 'Can look at everything except settings, but change nothing.',
    permissions: views.filter((k) => k !== 'config.view') },
];

// ── Request → permission rules ────────────────────────────────────────────────
type Rule = { re: RegExp; read?: string | null; write?: string | null };
/** `null` = allowed for every staff member. First matching rule wins. */
const RULES: Rule[] = [
  { re: /^\/api\/admin\/staff\/(me|tasks|notes|approvals)(\/|$)/i, read: null, write: null }, // checked again inside the controller
  { re: /^\/api\/admin\/reauth(\/|$)/i, read: null, write: null },
  { re: /^\/api\/admin\/staff(\/|$)/i, read: 'staff.view', write: 'staff.manage' },
  { re: /^\/api\/auth\/admin\/create-admin/i, write: 'staff.manage', read: 'staff.manage' },
  { re: /^\/api\/admin\/finance\/payouts\/[^/]+\/(approve|reject|retry|destination)/i, read: 'finance.payouts', write: 'finance.payouts' },
  { re: /^\/api\/admin\/finance(\/|$)/i, read: 'finance.view', write: 'finance.manage' },
  { re: /^\/api\/admin\/commission-rules(\/|$)/i, read: 'finance.view', write: 'finance.manage' },
  { re: /^\/api\/admin\/manual-payments(\/|$)/i, read: 'payments.view', write: 'payments.approve' },
  { re: /^\/api\/admin\/orders(\/|$)/i, read: 'orders.view', write: 'orders.manage' },
  { re: /^\/api\/orders\/(seller-orders|returns)/i, read: 'orders.view', write: 'orders.manage' },
  { re: /^\/api\/orders\/mark-paid/i, read: 'orders.view', write: 'payments.approve' },
  { re: /^\/api\/orders\/(update-status|return-action)/i, read: 'orders.view', write: 'orders.manage' },
  { re: /^\/api\/refund-request\/[^/]+\/(approve|reject)/i, read: 'orders.refund', write: 'orders.refund' },
  { re: /^\/api\/refund-request\/admin/i, read: 'orders.view', write: 'orders.refund' },
  { re: /^\/api\/admin\/users(\/|$)/i, read: 'users.view', write: 'users.manage' },
  { re: /^\/api\/admin\/marketplace\/leads/i, read: 'marketplace.view', write: 'stores.approve' },
  { re: /^\/api\/admin\/marketplace(\/|$)/i, read: 'marketplace.view', write: 'marketplace.manage' },
  { re: /^\/api\/admin\/moderation(\/|$)/i, read: 'moderation.view', write: 'moderation.manage' },
  { re: /^\/api\/rating\/(flag|unflag|admin|reply|edit-reply)/i, read: 'moderation.view', write: 'moderation.manage' },
  { re: /^\/api\/(admin\/chat|contact\/admin|messaging\/admin)(\/|$)/i, read: 'support.view', write: 'support.reply' },
  { re: /^\/api\/admin\/marketing(\/|$)/i, read: 'marketing.view', write: 'marketing.manage' },
  { re: /^\/api\/((banners|spotlight)\/(admin|count)|onboarding-slides\/admin|testimonials\/admin|admin\/announcements)/i, read: 'content.view', write: 'content.manage' },
  { re: /^\/api\/(banners|spotlight|onboarding-slides|testimonials|faqs|learning-paths|announcements)(\/|$)/i, write: 'content.manage' },
  { re: /^\/api\/categories\/admin/i, read: 'categories.manage', write: 'categories.manage' },
  { re: /^\/api\/categories(\/|$)/i, write: 'categories.manage' },
  { re: /^\/api\/admin\/seo(\/|$)/i, read: 'seo.view', write: 'seo.manage' },
  { re: /^\/api\/admin\/ai-studio(\/|$)/i, read: 'ai.manage', write: 'ai.manage' },
  { re: /^\/api\/(platform-plans\/admin|subscriptions\/admin|admin\/premium)(\/|$)/i, read: 'plans.view', write: 'plans.manage' },
  { re: /^\/api\/checkout\/admin(\/|$)/i, read: 'config.view', write: 'config.manage' },
  { re: /^\/api\/admin\/analytics(\/|$)/i, read: 'analytics.view', write: 'analytics.view' },
  { re: /^\/api\/admin\/activity-log(\/|$)/i, read: 'activity.view', write: 'activity.view' },
  { re: /^\/api\/admin\/platform-config(\/|$)/i, read: 'config.view', write: 'config.manage' },
];

/** Everything a signed-in person may always do (own session, uploads, notifications, own profile). */
const BASE_ALLOW = [/^\/api\/auth(\/|$)/i, /^\/api\/upload(\/|$)/i, /^\/api\/notifications(\/|$)/i, /^\/api\/users(\/|$)/i];

/** The permission a STAFF token needs for this request; `null` = allowed; `DENY` = never. */
export const DENY = '__deny__';
export function permissionForRequest(method: string, rawPath: string): string | null {
  const path = normalizeRequestPath(rawPath);
  if (path === null) return DENY;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  for (const r of RULES) {
    if (!r.re.test(path)) continue;
    const need = write ? r.write : r.read;
    return need === undefined ? null : need;
  }
  if (!path.startsWith('/api/')) return null;
  if (path.startsWith('/api/admin/')) return DENY; // default-deny for every admin route nobody mapped
  if (BASE_ALLOW.some((re) => re.test(path))) return null;
  return write ? DENY : null; // public reads are fine; unmapped writes are not
}

export function effectivePermissions(role: string[] | undefined, add: string[] | undefined, remove: string[] | undefined): string[] {
  const set = new Set<string>(sanitizePermissions(role));
  sanitizePermissions(add).forEach((k) => set.add(k));
  sanitizePermissions(remove).forEach((k) => set.delete(k));
  return [...set];
}
