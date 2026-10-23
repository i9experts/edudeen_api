import { AsyncLocalStorage } from 'async_hooks';

/** Who is calling, for audit entries written deep inside services that never see the request. */
export interface RequestAudit { ip?: string; userAgent?: string }

const storage = new AsyncLocalStorage<RequestAudit>();

/** Express middleware: keeps ip + user-agent available for the whole async chain of this request. */
export function requestAuditMiddleware(req: any, _res: any, next: () => void) {
  const ua = req.headers?.['user-agent'];
  storage.run({ ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : undefined }, next);
}

export function currentRequestAudit(): RequestAudit | undefined {
  return storage.getStore();
}