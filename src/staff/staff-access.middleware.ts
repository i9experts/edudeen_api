/* eslint-disable prettier/prettier */
import { StaffService } from './staff.service';
import { StaffExtrasService } from './staff-extras.service';
import { accessWindowViolation } from './access-window.util';
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
export function createStaffAccessMiddleware(staff: StaffService, extras?: StaffExtrasService) {
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
      const outside = accessWindowViolation(access, ip);
      if (outside) return deny('STAFF_OUTSIDE_ACCESS_WINDOW', outside);

      const need = permissionForRequest(req.method, req.path);
      if (need === DENY) return deny('STAFF_FORBIDDEN', 'You do not have access to this action.');
      if (need && !access.permissions.has(need)) return deny('STAFF_FORBIDDEN', 'Your role does not include this action.', need);

      // Two-person rule: sensitive money actions by staff wait for another person's approval.
      if (write && extras) {
        const gate = await extras.approvalGate(payload.sub, access.name, req.method, req.path);
        if (gate !== 'proceed') {
          void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: req.path, status: 202, ip, denied: `approval:${gate.label}` });
          return res.status(202).json({ success: true, approvalRequired: true, requestId: gate.requestId, message: `Sent for approval: . Another person must approve it, then you repeat this action once.` });
        }
      }

      if (write) res.on('finish', () => void staff.audit({ adminId: payload.sub, name: access.name, method: req.method, path: req.path, status: res.statusCode, ip }));
      return next();
    } catch {
      // Fail CLOSED for admin tokens: if rights cannot be checked, nothing is let through. Other traffic is unaffected.
      if (adminToken) return res.status(503).json({ statusCode: 503, code: 'ACCESS_CHECK_FAILED', message: 'Could not verify your access. Try again.' });
      return next();
    }
  };
}
