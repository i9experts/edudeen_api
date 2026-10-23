/* eslint-disable prettier/prettier */
import { StaffService } from './staff.service';
import { StaffExtrasService } from './staff-extras.service';
import { accessWindowViolation } from './access-window.util';
import { normalizeRequestPath } from '../common/request-path.util';
import { DENY, permissionForRequest } from './permissions';

type Access = Awaited<ReturnType<StaffService['accessFor']>>;
const cache = new Map<string, { at: number; v: Access }>();
const TTL = 15_000;
/** Drop cached rights (called after any staff change in this process). */
export const clearStaffAccessCache = () => cache.clear();

/** Normalised (lower-case, no trailing slash) admin GET paths that expose personal data. */
export const SENSITIVE_READS: RegExp[] = [
  /^\/api\/admin\/users\/[^/]+\/[^/]+$/i, // user detail
  /^\/api\/admin\/orders\/[^/]+$/i, // order detail (address, phone)
  /^\/api\/messaging\/admin\/conversations\/[^/]+$/i, // private buyer-seller chat (admin view)
  /^\/api\/admin\/finance\/payouts\/[^/]+\/destination$/i, // full bank / wallet destination
  /^\/api\/admin\/staff\/notes(\/|$)/i,
];

/**
 * Server-side enforcement for staff. Runs on every request:
 *  - no token / not an admin token / owner  -> untouched
 *  - staff token -> the route's permission (permissions.ts) must be in the person's effective set,
 *    the account must still be active and unexpired; everything unmapped under /api/admin is denied.
 *  - every state-changing request by staff is written to the staff audit trail.
 */
export function createStaffAccessMiddleware(staff: StaffService, extras?: StaffExtrasService) {
  return async (req: any, res: any, next: any) => {
    let adminToken = false;
    try {
      const auth: string | undefined = req.headers.authorization;
      const path = normalizeRequestPath(req.path);
      // A malformed encoding is only rejected for admin tokens below; everything else is left to the router.
      if (!auth?.startsWith('Bearer ') || (path !== null && !path.startsWith('/api/'))) return next();
      const payload = staff.verifyToken(auth.slice(7));
      if (!payload?.sub || payload.role !== 'admin' || (payload.typ && payload.typ !== 'access')) return next();
      adminToken = true;

      let hit = cache.get(payload.sub);
      if (!hit || Date.now() - hit.at > TTL) { hit = { at: Date.now(), v: await staff.accessFor(payload.sub) }; cache.set(payload.sub, hit); }
      const access = hit.v;
      if (!access || !access.isStaff) return next(); // owner (or unknown id -> the normal guards decide)
      if (path === null) return res.status(400).json({ statusCode: 400, code: 'BAD_PATH', message: 'Invalid request path.' });

      const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const ip = (req.ip as string) ?? '';
      const deny = (code: string, message: string, need?: string) => {
        if (write) void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: path ?? '', status: 403, ip, denied: need ?? code });
        return res.status(403).json({ statusCode: 403, code, message, permission: need ?? null });
      };
      if ((payload.tokenVersion ?? 0) !== access.tokenVersion) return next(); // stale token: JwtAuthGuard answers 401
      if (access.blocked) return deny('STAFF_BLOCKED', access.blocked);
      const outside = accessWindowViolation(access, ip);
      if (outside) return deny('STAFF_OUTSIDE_ACCESS_WINDOW', outside);

      const need = permissionForRequest(req.method, path);
      if (need === DENY) return deny('STAFF_FORBIDDEN', 'You do not have access to this action.');
      if (need && !access.permissions.has(need)) return deny('STAFF_FORBIDDEN', 'Your role does not include this action.', need);

      // Two-person rule: sensitive money actions by staff wait for another person's approval.
      if (write && extras) {
        const gate = await extras.approvalGate(payload.sub, access.name, req.method, path);
        if (gate !== 'proceed') {
          void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: path ?? '', status: 202, ip, denied: `approval:${gate.label}` });
          return res.status(202).json({ success: true, approvalRequired: true, requestId: gate.requestId, message: `Sent for approval: . Another person must approve it, then you repeat this action once.` });
        }
      }

      // Reads of personal data are audited too (who looked at which buyer, order, private chat or bank destination).
      if (!write && req.method === 'GET' && SENSITIVE_READS.some((re) => re.test(path))) res.on('finish', () => void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path, status: res.statusCode, ip }));
      if (write) res.on('finish', () => void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: path ?? '', status: res.statusCode, ip }));
      return next();
    } catch {
      // Fail CLOSED for admin tokens: if rights cannot be checked, nothing is let through. Other traffic is unaffected.
      if (adminToken) return res.status(503).json({ statusCode: 503, code: 'ACCESS_CHECK_FAILED', message: 'Could not verify your access. Try again.' });
      return next();
    }
  };
}
