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
  if (value.startsWith('/') && !value.startsWith('//')) return;

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
