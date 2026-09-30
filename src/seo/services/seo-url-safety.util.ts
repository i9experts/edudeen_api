/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

// Same production hosts CORS already trusts in main.ts — reused here as the
// allow-list for absolute redirect/canonical destinations so this doesn't
// become a second, drifting source of truth for "which hosts are ours."
const ALLOWED_ABSOLUTE_HOSTS = ['edudeen.com', 'staging.edudeen.com', 'api.edudeen.com'];

/**
 * Guards against open-redirect abuse in SeoRedirect/SeoCanonicalRule: a
 * destination/canonical URL must be either a same-origin-relative path
 * (starts with a single `/`, not `//` which browsers treat as protocol-
 * relative to an arbitrary host) or an absolute `https://` URL on one of our
 * own domains. Anything else is rejected outright — there is no legitimate
 * reason for this platform to redirect or canonicalize to a third-party host.
 */
export function assertSafeSeoDestination(value: string): void {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new BadRequestException('Destination must be a relative path (starting with "/") or a valid absolute URL.');
  }
  // Browsers strip tabs/newlines and treat a backslash as a slash, so "/\\evil.com", "/\t/evil.com" and "/%2f/evil.com"
  // all end up as protocol-relative "//evil.com". Reject control characters, whitespace and backslashes outright, and
  // re-check the percent-DECODED form for a leading "//" or "/\".
  if (/[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new BadRequestException('Destination contains characters that are not allowed.');
  }
  if (value.startsWith('/')) {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { throw new BadRequestException('Destination is not a valid path.'); }
    if (value.startsWith('//') || /^\/[\/\\]/.test(decoded) || /[\u0000-\u001f\u007f\\]/.test(decoded)) {
      throw new BadRequestException('Destination must be a same-site path, not a protocol-relative URL.');
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Destination must be a relative path (starting with "/") or a valid absolute URL.');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('Absolute destination URLs must use https.');
  }
  if (!ALLOWED_ABSOLUTE_HOSTS.includes(url.hostname)) {
    throw new BadRequestException(`Absolute destination URLs must point to a Edudeen domain (got "${url.hostname}").`);
  }
}

const SEO_META_KEYS = ['metaTitle', 'metaDescription', 'ogImage', 'ogTitle', 'ogDescription', 'twitterCard', 'canonicalUrlOverride', 'noindex', 'keywords'] as const;

/**
 * Whitelists and bounds the seller/admin-editable SEO meta fields before they are merged into a stored `seo` object.
 * The services used to spread the whole DTO (`{...current, ...dto}`), and the global ValidationPipe does not strip
 * unknown keys — so a request could write arbitrary keys (or `checklist`/`pages`) into the SEO sub-document. The
 * values end up in <meta> tags and JSON-LD, so they are also typed and length-limited here.
 */
export function pickSeoMeta(dto: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SEO_META_KEYS) {
    const v = dto?.[key];
    if (v === undefined) continue;
    if (key === 'noindex') {
      if (typeof v !== 'boolean') throw new BadRequestException('noindex must be true or false.');
    } else if (key === 'keywords') {
      if (!Array.isArray(v) || v.length > 20 || v.some((k) => typeof k !== 'string' || !k.trim() || k.length > 60)) {
        throw new BadRequestException('keywords must be at most 20 short strings.');
      }
    } else if (key === 'twitterCard') {
      if (v !== 'summary' && v !== 'summary_large_image') throw new BadRequestException('twitterCard must be "summary" or "summary_large_image".');
    } else {
      if (typeof v !== 'string' || v.length > (key === 'metaDescription' || key === 'ogDescription' ? 320 : 2048)) {
        throw new BadRequestException(`${key} must be text within the allowed length.`);
      }
      if (key === 'ogImage' && v && !/^https:\/\/\S+$/i.test(v)) throw new BadRequestException('ogImage must be an https URL.');
    }
    out[key] = v;
  }
  return out;
}
