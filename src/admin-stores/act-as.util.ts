/* eslint-disable prettier/prettier */
import { normalizeRequestPath } from '../common/request-path.util';
import { runAsActingStaff } from '../common/acting-staff.context';

/**
 * Admin "manage as seller" sessions are seller-role tokens locked to ONE store. Everything a seller can do
 * is allowed EXCEPT money-out and account-takeover actions, which are refused here (one central list instead of a
 * decorator per controller, so a new route cannot forget it). Reads (GET) are never refused, so an admin can still
 * SEE earnings, statements and reports.
 *
 * Paths are compared after `normalizeRequestPath` (lower-case, no trailing slash).
 */
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

interface DenyRule { re: RegExp; reason: string; allowMethods?: string[]; exceptRe?: RegExp }

export const ACT_AS_DENY_RULES: DenyRule[] = [
  { re: /^\/api\/finance\//, exceptRe: /^\/api\/finance\/[^/]+\/tax-reports\/generate$/, reason: 'Payout methods, payout requests and other money-out actions are not available while managing as admin.' },
  { re: /^\/api\/stripe-connect(\/|$)/, allowMethods: [], reason: 'Payment account setup is not available while managing as admin.' },
  { re: /^\/api\/platform-plans(\/|$)/, reason: 'Plan and billing changes are not available while managing as admin.' },
  { re: /^\/api\/users(\/|$)/, reason: 'Account changes (password, e-mail, delete) are not available while managing as admin.' },
  { re: /^\/api\/auth(\/|$)/, exceptRe: /^\/api\/auth\/logout$/, reason: 'Account changes are not available while managing as admin.' },
];

/** Returns the refusal text, or null when the request is allowed. */
export function actAsDeniedReason(method: string, normalizedPath: string): string | null {
  const m = String(method || 'GET').toUpperCase();
  for (const rule of ACT_AS_DENY_RULES) {
    if (!rule.re.test(normalizedPath)) continue;
    if (rule.exceptRe?.test(normalizedPath)) continue;
    // allowMethods: [] = no method is allowed (even GET). Default = reads are allowed.
    const readsAllowed = rule.allowMethods ? rule.allowMethods.includes(m) : READ.has(m);
    if (readsAllowed) continue;
    return rule.reason;
  }
  // A seller deleting their whole store is not an admin-session action either.
  if (m === 'DELETE' && /^\/api\/store\/[^/]+$/.test(normalizedPath)) return 'Deleting a store is not available while managing as admin.';
  return null;
}

/** Audit category for a write, from the first path segment (the activity-log filter UI uses these). */
export function actAsCategory(normalizedPath: string): 'products' | 'orders' | 'marketing' | 'customers' | 'settings' {
  if (/^\/api\/(products|inventory|collections|bundles|categories|upload)/.test(normalizedPath)) return 'products';
  if (/^\/api\/(orders|refund-request|couriers)/.test(normalizedPath)) return 'orders';
  if (/^\/api\/(marketing|promotions|banners|store-banner|gift-cards|loyalty|seller\/marketing)/.test(normalizedPath)) return 'marketing';
  if (/^\/api\/(messaging|rating)/.test(normalizedPath)) return 'customers';
  return 'settings';
}

interface Deps {
  verify: (token: string) => any | null;
  log: (entry: any) => Promise<boolean>;
}

/**
 * Express middleware. Only acts on `actAs: 'admin'` tokens (everything else passes untouched):
 *  - the store id sent in query/body must be the token's store,
 *  - money-out / account routes are refused (ACT_AS_FORBIDDEN),
 *  - every WRITE is audited BEFORE it runs; if the audit entry cannot be stored the request is refused (503).
 */
export function createActAsMiddleware(deps: Deps) {
  return async (req: any, res: any, next: any) => {
    let actAs = false;
    try {
      const auth: string | undefined = req.headers?.authorization;
      if (!auth?.startsWith('Bearer ')) return next();
      const payload = deps.verify(auth.slice(7));
      if (!payload?.sub || payload.actAs !== 'admin' || (payload.typ && payload.typ !== 'access')) return next();
      actAs = true;

      const path = normalizeRequestPath(req.path);
      if (path === null) return res.status(400).json({ statusCode: 400, code: 'BAD_PATH', message: 'Invalid request path.' });
      if (!path.startsWith('/api/')) return next();

      const storeId = String(payload.storeId ?? '');
      const sent = req.query?.storeId ?? req.body?.storeId;
      if (!storeId || (typeof sent === 'string' && sent && sent !== storeId)) {
        return res.status(403).json({ statusCode: 403, code: 'ACT_AS_OTHER_STORE', message: 'This session can only manage one store.' });
      }

      const denied = actAsDeniedReason(req.method, path);
      if (denied) return res.status(403).json({ statusCode: 403, code: 'ACT_AS_FORBIDDEN', message: denied });

      if (!READ.has(String(req.method).toUpperCase())) {
        const ok = await deps.log({
          storeId,
          category: actAsCategory(path),
          action: 'admin_act_as_write',
          description: `Admin ${req.method} ${path} while managing the store as the seller`,
          actorId: String(payload.actAsAdminId ?? ''),
          actorRole: 'admin',
          targetId: storeId,
          targetType: 'store',
          metadata: { actAsSeller: true, method: req.method, path },
        });
        if (!ok) return res.status(503).json({ statusCode: 503, code: 'AUDIT_UNAVAILABLE', message: 'Could not record this action. Try again.' });
        // The rest of this write runs with the team member's id in context, so what it creates or changes
        // (messages, products, order steps) is attributed to them (common/acting-staff.context.ts).
        const staffId = String(payload.actAsAdminId ?? '');
        if (staffId) return runAsActingStaff({ staffId, storeId }, () => next());
      }
      return next();
    } catch {
      // Fail closed for manage sessions only; other traffic is unaffected.
      if (actAs) return res.status(503).json({ statusCode: 503, code: 'ACCESS_CHECK_FAILED', message: 'Could not verify this session. Try again.' });
      return next();
    }
  };
}
