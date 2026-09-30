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
  if (!product?.digital) return product;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { files, preview, buyerDeliveryMessage, ...safeDigital } =
    product.digital as DigitalShape;
  return {
    ...product,
    digital: {
      ...safeDigital,
      fileCount: Array.isArray(files) ? files.length : 0,
      previewAvailable: !!preview?.enabled,
    },
  } as T;
}

/** Coerces an untrusted query value to a bounded integer (query strings can arrive as arrays/objects). */
export function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === 'string' || typeof value === 'number'
      ? Math.trunc(Number(value))
      : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Only accepts a real string; `?x[$ne]=y` (an object) and `?x[]=a` (an array) become undefined. */
export function queryString(
  value: unknown,
  maxLength = 200,
): string | undefined {
  return typeof value === 'string' && value.length <= maxLength
    ? value
    : undefined;
}
