/**
 * Off-platform contact detector for listing text (title, description). Edudeen sells must go through Edudeen, so a
 * listing that shows a phone number, WhatsApp, Telegram or an e-mail address is NOT rejected: it is saved but held in
 * the admin review queue (flags: ['contact_info']) with the matched text so a reviewer can decide in seconds.
 * Mirrors edudeen_web/.../products/productQuality.ts `findContactInfo` (instant seller warning); this is the authority.
 *
 * It must NOT fire on ISBNs, prices, years, page counts or class numbers - see contact-info.util.spec.ts.
 */
export const CONTACT_FLAG = 'contact_info';

export interface ContactMatch { type: 'email' | 'phone' | 'whatsapp' | 'telegram'; text: string }

// Pakistani mobile: +92 300 1234567 / 0092-300-1234567 / 92 300 1234567 / 0300-1234567 / 03001234567.
const PK_MOBILE = /(?<![\d.])(?:(?:\+|00)?92[\s.-]?\(?0?3\d{2}\)?[\s.-]?\d{7}|0\(?3\d{2}\)?[\s.-]?\d{7})(?![\d])/g;
// Other international numbers always start with "+" (so a bare long number such as an ISBN never matches).
const INTL_PHONE = /(?<![\w])\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\d])/g;
// Landline with area code and a separator: 042-35761234, 021 3456 7890.
const PK_LANDLINE = /(?<![\d.])0(?:2[1-9]|4[1-9]|5[1-9]|6[1-9]|9[1-9])\d?[\s.-]\d{3,4}[\s.-]?\d{4}(?![\d])/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// "name (at) gmail (dot) com" style obfuscation.
const EMAIL_OBFUSCATED = /[A-Z0-9._%+-]+\s*[(\[]\s*at\s*[)\]]\s*[A-Z0-9-]+\s*[(\[]?\s*dot\s*[)\]]?\s*[A-Z]{2,}/gi;
const WHATSAPP = /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|web\.whatsapp\.com)\/\S*|wh?atsa+p+\b|whats\s?app|واٹس\s?ایپ|واٹسپ/gi;
const TELEGRAM = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/\S*|\btelegram\b/gi;

function collect(text: string, re: RegExp, type: ContactMatch['type'], out: ContactMatch[], keep: (m: string) => boolean = () => true) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s && keep(s)) out.push({ type, text: s.slice(0, 80) });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

const digitsOnly = (s: string) => s.replace(/\D/g, '');

/** All contact details found in `text` (empty = clean). */
export function findContactInfo(text: string | null | undefined): ContactMatch[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const out: ContactMatch[] = [];
  collect(t, EMAIL, 'email', out);
  collect(t, EMAIL_OBFUSCATED, 'email', out);
  collect(t, WHATSAPP, 'whatsapp', out);
  collect(t, TELEGRAM, 'telegram', out);
  collect(t, PK_MOBILE, 'phone', out, (s) => digitsOnly(s).length >= 10);
  collect(t, INTL_PHONE, 'phone', out, (s) => { const n = digitsOnly(s).length; return n >= 9 && n <= 15; });
  collect(t, PK_LANDLINE, 'phone', out, (s) => digitsOnly(s).length >= 9);
  // de-duplicate by text
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.text.toLowerCase()) ? false : (seen.add(m.text.toLowerCase()), true)));
}

/** Scans the seller-written text fields of a listing. `fields` = only the fields being saved. */
export function scanListingText(fields: Record<string, unknown>): { flagged: boolean; matches: string[]; reason: string | null } {
  const matches: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    for (const m of findContactInfo(value)) matches.push(`${field}: ${m.text}`);
  }
  return {
    flagged: matches.length > 0,
    matches: matches.slice(0, 10),
    reason: matches.length ? 'Contains contact info (phone, WhatsApp, Telegram or email) - all sales must go through Edudeen.' : null,
  };
}

/**
 * TODO(OCR): scan the product images for phone numbers / WhatsApp / emails painted into the picture. Wire a real
 * OCR (e.g. the Claude-vision receipt-check service) here, then flag with CONTACT_FLAG exactly like text matches.
 * Intentionally a no-op for now; the call sites in ProductsService (create + update) are already in place.
 */
export async function scanImagesForContactInfo(_productId: string, _imageUrls: string[]): Promise<void> {
  return;
}
