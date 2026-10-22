/* eslint-disable prettier/prettier */
/** Before/after snapshot for the activity log of money settings. Account numbers are masked to their last 4 characters. */
const SENSITIVE = /(account|iban|number)/i;

export function maskValue(key: string, v: unknown): unknown {
  if (typeof v === 'string' && v && SENSITIVE.test(key)) return v.length <= 4 ? '****' : `****${v.slice(-4)}`;
  return v ?? null;
}

/** Only the keys that were sent AND really differ; values masked. */
export function auditDiff(before: Record<string, any> | null | undefined, sent: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sent)) {
    if (value === undefined) continue;
    const old = before?.[key];
    if (JSON.stringify(old ?? null) === JSON.stringify(value ?? null)) continue;
    b[key] = maskValue(key, old);
    a[key] = maskValue(key, value);
  }
  return { before: b, after: a, changed: Object.keys(a) };
}