/* eslint-disable prettier/prettier */
/** Best-seller badge rule. A product earns it only when it is among the cached top sellers AND has really sold enough. */
export const BESTSELLER_MIN_SOLD = 10;

export function isBestsellerBadge(productId: string, purchaseCount: number | null | undefined, topIds: readonly string[]): boolean {
  return Number(purchaseCount ?? 0) >= BESTSELLER_MIN_SOLD && topIds.includes(String(productId));
}

/** Series table: same store, same series name (case-insensitive), ordered by seriesOrder then name, at most `max` rows. */
export const SERIES_MAX_ROWS = 8;

export function pickSeriesRows<T extends { _id: unknown; seriesOrder?: number | null; name?: string }>(rows: T[], max = SERIES_MAX_ROWS): T[] {
  return [...rows]
    .sort((a, b) => (a.seriesOrder ?? 1e9) - (b.seriesOrder ?? 1e9) || String(a.name ?? '').localeCompare(String(b.name ?? '')))
    .slice(0, max);
}
