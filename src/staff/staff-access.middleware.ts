/* eslint-disable prettier/prettier */
import { StaffService } from './staff.service';
import { DENY, permissionForRequest } from './permissions';

type Access = Awaited<ReturnType<StaffService['accessFor']>>;
const cache = new Map<string, { at: number; v: Access }>();
const TTL = 15_000;
/** Drop cached rights (called after any staff change in this process). */
export const clearStaffAccessCache = () => cache.clear();

/**
 * Server-side enforcement for staff. Runs on every request:
 *  - no token / not an admin token / owner  -> untouched
 *  - staff token -> the route's permission (permissions.ts) must be in the person's effective set,
 *    the account must still be active and unexpired; everything unmapped under /api/admin is denied.
 *  - every state-changing request by staff is written to the staff audit trail.
 */
export function createStaffAccessMiddleware(staff: StaffService) {
  return async (req: any, res: any, next: any) => {
    let adminToken = false;
    try {
      const auth: string | undefined = req.headers.authorization;
      if (!auth?.startsWith('Bearer ') || !req.path.startsWith('/api/')) return next();
      const payload = staff.verifyToken(auth.slice(7));
      if (!payload?.sub || payload.role !== 'admin' || (payload.typ && payload.typ !== 'access')) return next();
      adminToken = true;

      let hit = cache.get(payload.sub);
      if (!hit || Date.now() - hit.at > TTL) { hit = { at: Date.now(), v: await staff.accessFor(payload.sub) }; cache.set(payload.sub, hit); }
      const access = hit.v;
      if (!access || !access.isStaff) return next(); // owner (or unknown id -> the normal guards decide)

      const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const ip = (req.ip as string) ?? '';
      const deny = (code: string, message: string, need?: string) => {
        if (write) void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: req.path, status: 403, ip, denied: need ?? code });
        return res.status(403).json({ statusCode: 403, code, message, permission: need ?? null });
      };
      if ((payload.tokenVersion ?? 0) !== access.tokenVersion) return next(); // stale token: JwtAuthGuard answers 401
      if (access.blocked) return deny('STAFF_BLOCKED', access.blocked);

      const need = permissionForRequest(req.method, req.path);
      if (need === DENY) return deny('STAFF_FORBIDDEN', 'You do not have access to this action.');
      if (need && !access.permissions.has(need)) return deny('STAFF_FORBIDDEN', 'Your role does not include this action.', need);

      if (write) res.on('finish', () => void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: req.path, status: res.statusCode, ip }));
      return next();
    } catch {
      // Fail CLOSED for admin tokens: if rights cannot be checked, nothing is let through. Other traffic is unaffected.
      if (adminToken) return res.status(503).json({ statusCode: 503, code: 'ACCESS_CHECK_FAILED', message: 'Could not verify your access. Try again.' });
      return next();
    }
  };
}
