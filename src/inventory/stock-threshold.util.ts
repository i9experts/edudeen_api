/** Default "running low" line when a product has no limit of its own. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;
export const MAX_LOW_STOCK_THRESHOLD = 1000;

/** A stored per-product limit (whole 0..1000) or the default. Anything else (null, junk, old products) = default. */
export function effectiveThreshold(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_LOW_STOCK_THRESHOLD
    ? raw
    : DEFAULT_LOW_STOCK_THRESHOLD;
}

/**
 * THE low-stock rule (Inventory cards + list, dashboard count, low-stock notification all call this):
 * some stock left, but not more than the limit. 0 or less is "out of stock", never "low". Limit 0 = never low.
 */
export function isLowStock(stock: number, threshold: unknown): boolean {
  return stock > 0 && stock <= effectiveThreshold(threshold);
}

/** Parses a seller-typed limit: whole number 0..1000 or null (= back to the default). Returns undefined when invalid. */
export function parseThresholdInput(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_LOW_STOCK_THRESHOLD ? raw : undefined;
}
