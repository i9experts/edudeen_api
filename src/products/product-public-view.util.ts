/**
 * What a NON-owner may see of a digital product. The private file manifest (publicIds/names/sizes/mime
 * types) and the server-managed preview source are never exposed, and neither is `buyerDeliveryMessage` —
 * that is the text shown AFTER purchase (download instructions, license keys, private links).
 * Used by every public listing/detail path so they can't drift apart.
 */
interface DigitalShape {
  files?: unknown;
  preview?: { enabled?: boolean } | null;
  buyerDeliveryMessage?: unknown;
  [key: string]: unknown;
}

export function sanitizeDigitalForPublicView<T extends { digital?: unknown }>(
  product: T,
): T {
  product = hideAiReview(hideLiveLink(product));
  if (!product?.digital) return product;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { files, preview, buyerDeliveryMessage, sampleFile, ...safeDigital } =
    product.digital as DigitalShape;
  const sample = sampleFile as { name?: string } | null | undefined;
  return {
    ...product,
    digital: {
      ...safeDigital,
      fileCount: Array.isArray(files) ? files.length : 0,
      previewAvailable: !!preview?.enabled,
      // The sample itself is fetched through GET /api/products/:id/sample.
      sampleAvailable: !!sample,
      sampleName: sample?.name ?? null,
    },
  } as T;
}

/** The admin-only AI pre-moderation result never goes into public views. */
function hideAiReview<T>(product: T): T {
  if (!product || typeof product !== 'object') return product;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { aiReview, ...rest } = product as Record<string, unknown>;
  // The trust badge is public; who set it (an admin id) is not.
  const trust = rest.trust as Record<string, unknown> | null | undefined;
  if (trust && typeof trust === 'object' && 'reviewedBy' in trust) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { reviewedBy, ...publicTrust } = trust;
    rest.trust = publicTrust;
  }
  return rest as T;
}

/** A live class's meeting link goes only to buyers (GET /api/courses/live/:productId), never into public views. */
function hideLiveLink<T>(product: T): T {
  const live = (product as { liveSession?: { meetingUrl?: unknown } | null } | null)?.liveSession;
  if (!live) return product;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { meetingUrl, ...rest } = live as Record<string, unknown>;
  return { ...product, liveSession: rest } as T;
}

export { clampInt } from '../common/query-safety.util';

/** Only accepts a real string; `?x[$ne]=y` (an object) and `?x[]=a` (an array) become undefined. */
export function queryString(
  value: unknown,
  maxLength = 200,
): string | undefined {
  return typeof value === 'string' && value.length <= maxLength
    ? value
    : undefined;
}
