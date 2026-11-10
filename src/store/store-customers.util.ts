/** Pure helpers for the seller Customers page: masking, phone search, sorting, notes cleaning. */

/** s***5@gmail.com — first and last character of the local part; very short names keep one character. */
export function maskEmail(email: unknown): string {
  const s = typeof email === 'string' ? email.trim() : '';
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? '***' : '';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

/** National 10-digit part of a Pakistani number (03xx / 3xx / +923xx / 923xx / 00923xx), else the raw digits. */
export function phoneNational(raw: unknown): string {
  let d = String(raw ?? '').replace(/\D+/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && (d.length >= 11 || d[2] === '3')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}

/** +92 3** ***0161 — first national digit and last four digits only. Non-PK numbers keep just the last four. */
export function maskPhone(phone: unknown): string {
  const raw = typeof phone === 'string' ? phone.trim() : '';
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 7) return '***';
  const nat = phoneNational(raw);
  if (/^3\d{9}$/.test(nat)) return `+92 ${nat[0]}** ***${nat.slice(-4)}`;
  return `*** ***${digits.slice(-4)}`;
}

/** A search box value that looks like a phone number (digits, spaces, +, -, brackets; >= 3 digits). */
export function parsePhoneQuery(q: string): { raw: string; national: string } | null {
  if (!/^[\d\s+()-]+$/.test(q)) return null;
  const raw = q.replace(/\D+/g, '');
  if (raw.length < 3) return null;
  return { raw, national: phoneNational(raw) };
}

/** Same customer under 03xx, 3xx, +923xx or 923xx: compare on the national part and on the raw digits. */
export function phoneMatches(stored: unknown, query: { raw: string; national: string }): boolean {
  const digits = String(stored ?? '').replace(/\D+/g, '');
  if (!digits) return false;
  const nat = phoneNational(stored);
  const last10 = (s: string) => (s.length > 10 ? s.slice(-10) : s);
  const qNat = last10(query.national);
  return (!!qNat && last10(nat).includes(qNat)) || digits.includes(query.raw);
}

export const CUSTOMER_SORT_FIELDS = ['orderCount', 'totalSpent', 'lastOrderAt', 'createdAt'] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

export function parseCustomerSort(sort: unknown, order: unknown): { field: CustomerSortField; dir: 1 | -1 } {
  const field = (CUSTOMER_SORT_FIELDS as readonly string[]).includes(String(sort)) ? (String(sort) as CustomerSortField) : 'lastOrderAt';
  return { field, dir: String(order) === 'asc' ? 1 : -1 };
}

/** Stable sort: chosen field (missing dates last), then _id so pages never repeat or skip a row. */
export function sortCustomerRows<T extends { _id: string }>(
  rows: T[],
  field: CustomerSortField,
  dir: 1 | -1,
  value: (r: T, f: CustomerSortField) => number | null,
): T[] {
  return [...rows].sort((a, b) => {
    const x = value(a, field);
    const y = value(b, field);
    if (x == null && y != null) return 1;
    if (x != null && y == null) return -1;
    if (x != null && y != null && x !== y) return (x - y) * dir;
    return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
  });
}

export const NOTE_MAX = 500;
export const TAG_MAX = 20;
export const TAGS_MAX = 5;

/** Trim, drop empties, de-duplicate (case-insensitive); throws a message string when a limit is broken. */
export function cleanNoteInput(note: unknown, tags: unknown): { note: string; tags: string[] } | { error: string } {
  const n = typeof note === 'string' ? note.trim() : '';
  if (n.length > NOTE_MAX) return { error: `Note can be at most ${NOTE_MAX} characters` };
  const raw = Array.isArray(tags) ? tags : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') return { error: 'Tags must be text' };
    const v = t.trim();
    if (!v) continue;
    if (v.length > TAG_MAX) return { error: `Each tag can be at most ${TAG_MAX} characters` };
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  if (out.length > TAGS_MAX) return { error: `You can add at most ${TAGS_MAX} tags` };
  return { note: n, tags: out };
}
