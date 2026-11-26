/* eslint-disable prettier/prettier */
import { normalizeRequestPath } from '../common/request-path.util';
import { memberRequirement } from './permissions';

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface MemberAccess { active: boolean; reason?: string; name: string; roleKey: string; permissions: Set<string> }

interface Deps {
  verify: (token: string) => any | null;
  /** Live member + store + owner check (cached ~30 s by the caller). Must resolve `active:false` when anything is off. */
  access: (memberId: string, storeId: string, sellerId: string) => Promise<MemberAccess>;
  log: (entry: any) => Promise<boolean>;
}

function category(path: string): 'products' | 'orders' | 'marketing' | 'customers' | 'settings' {
  if (/^\/api\/(products|inventory|collections|bundles|categories|upload)/.test(path)) return 'products';
  if (/^\/api\/(orders|refund-request|couriers)/.test(path)) return 'orders';
  if (/^\/api\/(marketing|promotions|banners|store-banner|gift-cards|loyalty|seller\/marketing)/.test(path)) return 'marketing';
  if (/^\/api\/(messaging|rating)/.test(path)) return 'customers';
  return 'settings';
}

/**
 * Express middleware for store team members (`actAs:'collaborator'` tokens; everything else passes untouched):
 *  - the member must still be ACTIVE, unexpired, on an active store whose owner is usable (checked every request, fail CLOSED),
 *  - owner-only areas are refused for every role (permissions.ts),
 *  - a write needs the matching permission; an unmapped write is refused,
 *  - every WRITE is audited BEFORE it runs (actor = the member); if the entry cannot be stored the request is refused (503).
 */
export function createMemberAccessMiddleware(deps: Deps) {
  return async (req: any, res: any, next: any) => {
    let member = false;
    try {
      const auth: string | undefined = req.headers?.authorization;
      if (!auth?.startsWith('Bearer ')) return next();
      const p = deps.verify(auth.slice(7));
      if (!p?.sub || p.actAs !== 'collaborator' || (p.typ && p.typ !== 'access')) return next();
      member = true;

      const path = normalizeRequestPath(req.path);
      if (path === null) return res.status(400).json({ statusCode: 400, code: 'BAD_PATH', message: 'Invalid request path.' });
      if (!path.startsWith('/api/')) return next();

      const storeId = String(p.storeId ?? '');
      const memberId = String(p.memberId ?? '');
      if (!storeId || !memberId) return res.status(403).json({ statusCode: 403, code: 'MEMBER_ACCESS_ENDED', message: 'This session is not valid.' });
      const sent = req.query?.storeId ?? req.body?.storeId;
      if (typeof sent === 'string' && sent && sent !== storeId) {
        return res.status(403).json({ statusCode: 403, code: 'MEMBER_OTHER_STORE', message: 'This session can only work in one store.' });
      }

      const a = await deps.access(memberId, storeId, String(p.sub));
      if (!a.active) return res.status(403).json({ statusCode: 403, code: 'MEMBER_ACCESS_ENDED', message: a.reason || 'Your access to this store has ended.' });

      const need = memberRequirement(req.method, path);
      if (need.denied) return res.status(403).json({ statusCode: 403, code: 'MEMBER_FORBIDDEN', message: need.denied });
      if (need.need && !a.permissions.has(need.need)) {
        return res.status(403).json({ statusCode: 403, code: 'MEMBER_FORBIDDEN', message: 'Your role does not include this action.', permission: need.need });
      }

      if (!READ.has(String(req.method).toUpperCase())) {
        const ok = await deps.log({
          storeId, category: category(path), action: 'store_member_write',
          description: `${a.name || 'A team member'} (${a.roleKey}) ${req.method} ${path}`,
          actorId: memberId, actorName: a.name || null, actorRole: 'collaborator',
          targetId: storeId, targetType: 'store',
          metadata: { actAs: 'collaborator', role: a.roleKey, method: req.method, path },
        });
        if (!ok) return res.status(503).json({ statusCode: 503, code: 'AUDIT_UNAVAILABLE', message: 'Could not record this action. Try again.' });
      }
      return next();
    } catch {
      if (member) return res.status(503).json({ statusCode: 503, code: 'ACCESS_CHECK_FAILED', message: 'Could not verify your access. Try again.' });
      return next();
    }
  };
}
