/**
 * Model output is untrusted text (it is shaped by seller-supplied titles/descriptions/keywords AND by web-search
 * results, so prompt injection can put anything in it). It is written straight into public product fields, so it is
 * reduced to plain, bounded text here — the normal product DTO validation is bypassed by the accept flow.
 */
const stripMarkup = (s: string) =>
  s
    .replace(/<[^>]*>/g, ' ') // drop tags (keep the words)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

export function cleanAiText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripMarkup(value).slice(0, maxLength).trim();
  return cleaned || null;
}

export function cleanAiTags(
  value: unknown,
  maxTags = 20,
  maxLength = 40,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const t = cleanAiText(
      typeof raw === 'string' ? raw : (raw as { tag?: unknown } | null)?.tag,
      maxLength,
    );
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= maxTags) break;
  }
  return out.length ? out : null;
}
