/**
 * Top-level web paths that are real app pages, never a store. A link like `edudeen.com/<store-slug>` is only answered
 * with a store's preview HTML when the first segment is NOT one of these (and is an active store).
 */
export const ROOT_RESERVED_SEGMENTS = new Set<string>([
  // app pages
  'about', 'faq', 'contact-us', 'learn', 'premium', 'become-a-seller', 'privacy-policy', 'terms-of-service', 'cookie-policy',
  'returns', 'sitemap', 'pricing', 'sellers', 'account', 'marketplace', 'cart', 'checkout', 'order-success', 'education',
  'educationmarketplace', 'product', 'maintenance', 'login', 'register', 'onboard', 'onboarding', 'forgot-password',
  'verify-otp', 'new-password', 'seller', 'admin', 'store', 'shop', 'browse', 'c', 'course', 'wishlist', 'compare',
  'bundles', 'picks', 'seasonal', 'learning-paths', 'search', 'api', 'assets', 'robots', 'sitemap-index',
]);

/** A plausible store slug: lower-case letters, digits and dashes (what the slug generator produces). */
export const ROOT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;

export function isRootStoreSlugCandidate(slug: string): boolean {
  const s = String(slug ?? '');
  return ROOT_SLUG_RE.test(s) && !/^[a-f0-9]{24}$/.test(s) && !ROOT_RESERVED_SEGMENTS.has(s);
}
