/* eslint-disable prettier/prettier */

/**
 * Strip personal data from free text BEFORE it is sent to the model: emails, phone numbers,
 * CNIC numbers and long card-like digit runs. Keeps ordinary numbers (prices, grades, years) intact.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CNIC = /\b\d{5}-\d{7}-\d\b/g;
// +92 300 1234567, 0300-1234567, (021) 1234 5678, +1 415 555 0100 ...
const PHONE = /(?<![\w.])(?:\+|00)?\d{1,3}[\s().-]*(?:\d[\s().-]*){8,11}\d(?![\w.])/g;
const LOCAL_PHONE = /(?<!\d)0\d{2,3}[\s-]?\d{7,8}(?!\d)/g;
const LONG_DIGITS = /\b\d{13,19}\b/g;

export function stripPii(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL, '[email]')
    .replace(CNIC, '[id]')
    .replace(LONG_DIGITS, '[number]')
    .replace(LOCAL_PHONE, '[phone]')
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m));
}

/** Deep-strip every string in a JSON-able value (objects/arrays), returning a copy. */
export function stripPiiDeep<T>(value: T): T {
  if (typeof value === 'string') return stripPii(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripPiiDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    // Never walk image/document blocks (base64 payloads or URLs): leave them untouched.
    const kind = (value as { type?: unknown }).type;
    if (kind === 'image' || kind === 'document') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripPiiDeep(v);
    return out as T;
  }
  return value;
}
