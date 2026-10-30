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
  // The free-sample download is no longer offered to buyers (sellers still upload one; it is not exposed here).
  void sampleFile;
  return {
    ...product,
    digital: {
      ...safeDigital,
      fileCount: Array.isArray(files) ? files.length : 0,
      // Short upper-case extensions (PDF, DOCX, MP4...) so the page can say what the buyer gets without the manifest.
      fileFormats: fileFormatsOf(files),
      previewAvailable: !!preview?.enabled,
    },
  } as T;
}

function fileFormatsOf(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const out = new Set<string>();
  for (const f of files as { name?: unknown }[]) {
    const m = typeof f?.name === 'string' ? /\.([a-z0-9]{1,5})$/i.exec(f.name) : null;
    if (m) out.add(m[1].toUpperCase());
  }
  return [...out].slice(0, 6);
}

/** The admin-only AI pre-moderation result never goes into public views. */
function hideAiReview<T>(product: T): T {
  if (!product || typeof product !== 'object') return product;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // A seller's unapproved edit (private file ids included) and the rejection note are seller/admin-only too.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    aiReview, pendingEdit, lastEditRejection,
    flags, flagReason, contactMatches, reviewNote, reviewedAt, removedByAdmin,
    isDelete, isTest, ratingSum, normalizedCustomLevel, aiReviewSummary,
    ...rest
  } = product as Record<string, unknown>;
  // Internal moderation/bookkeeping fields are never part of a public product (`previousSlugs` is kept: the product
  // page uses it to redirect an old URL, `trust` is the public badge below).
  void flags; void flagReason; void contactMatches; void reviewNote; void reviewedAt; void removedByAdmin;
  void isDelete; void isTest; void ratingSum; void normalizedCustomLevel; void aiReviewSummary;
  // The trust badge is public; who set it (an admin id) is not.
  const trust = rest.trust as Record<string, unknown> | null | undefined;
  if (trust && typeof trust === 'object' && 'reviewedBy' in trust) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { reviewedBy, ...publicTrust } = trust;
    rest.trust = publicTrust;
  }
  return rest as T;
}

/** Live classes are retired; an old product doc may still carry liveSession (with a meeting link) - never expose it. */
function hideLiveLink<T>(product: T): T {
  if (!product || typeof product !== 'object' || !('liveSession' in (product as object))) return product;
  const { liveSession, ...rest } = product as Record<string, unknown>;
  void liveSession;
  return rest as T;
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
