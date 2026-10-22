/**
 * One canonical form of a request path for every security decision (staff rights, approvals, maintenance).
 * Express routes case-insensitively and tolerates `//` and a trailing `/`, so raw `req.path` must never be
 * regex-matched directly. Returns null for a malformed percent-encoding (callers must reject the request).
 * Result: decoded, `.`/`..` segments resolved, `//` collapsed, no trailing `/`, lower-case.
 */
export function normalizeRequestPath(path: string | undefined | null): string | null {
  let p = String(path ?? '');
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  p = p.replace(/\\/g, '/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/').toLowerCase();
}
