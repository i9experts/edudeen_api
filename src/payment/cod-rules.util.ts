/* eslint-disable prettier/prettier */
// Cash-on-delivery rules shared by checkout (what to offer) and payment (what to enforce).
// A "package" = one seller's physical items + that seller's shipping line. Amounts are in the checkout currency;
// the admin's limit / fee are PKR and are converted with the checkout's FROZEN fx snapshots by the caller.

export interface CodConfigPKR { maxPerPackagePKR: number | null; feePerPackagePKR: number }

export interface CodPackage { storeId: string; itemsTotal: number; shipping: number; total: number }

export interface CodEvaluation {
  /** false when at least one package is over the admin's limit. */
  available: boolean;
  reason: string | null;
  /** Limit / fee in the checkout currency (null / 0 = none). */
  maxPerPackage: number | null;
  feePerPackage: number;
  packageCount: number;
  feeTotal: number;
  /** storeId -> COD fee (checkout currency) for the packages that carry one (Edudeen-collected only). */
  feeByStore: Record<string, number>;
  overLimitStoreIds: string[];
}

type Convert = (amount: number, from: string, to: string) => number;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One entry per store that has physical items. Shipping falls back to the legacy single flat fee (first physical store). */
export function codPackagesOf(checkout: any, convert: Convert): CodPackage[] {
  const physical = ((checkout?.items ?? []) as any[]).filter((i) => i.type === 'physical');
  const storeIds = [...new Set(physical.map((i) => String(i.storeId)))];
  const lines: any[] = (checkout?.shippingByStore ?? []) as any[];
  const shippingBy = new Map<string, number>(lines.map((l) => [String(l.storeId), Number(l.fee) || 0]));
  if (shippingBy.size === 0 && (checkout?.shippingFee || 0) > 0 && storeIds[0]) shippingBy.set(storeIds[0], checkout.shippingFee);
  return storeIds.map((storeId) => {
    const itemsTotal = round2(
      physical
        .filter((i) => String(i.storeId) === storeId)
        .reduce((s, i) => s + convert(i.totalPrice ?? 0, i.currency ?? checkout.currency, checkout.currency), 0),
    );
    const shipping = round2(shippingBy.get(storeId) ?? 0);
    return { storeId, itemsTotal, shipping, total: round2(itemsTotal + shipping) };
  });
}

/**
 * Applies the admin's COD limit and fee to a checkout. With nothing configured (no limit, no fee) it never
 * converts anything and returns "available" - behaviour identical to before the setting existed.
 */
export function evaluateCod(checkout: any, cfg: CodConfigPKR, convert: Convert, feeStoreIds?: string[]): CodEvaluation {
  const physicalStores = new Set(((checkout?.items ?? []) as any[]).filter((i) => i.type === 'physical').map((i) => String(i.storeId)));
  const storeCount = physicalStores.size;
  // The fee only applies to packages whose cash lands with Edudeen (its courier). undefined = every package.
  const feeStores = (feeStoreIds ? feeStoreIds.map(String).filter((s) => physicalStores.has(s)) : [...physicalStores]);
  const base: CodEvaluation = { available: true, reason: null, maxPerPackage: null, feePerPackage: 0, packageCount: storeCount, feeTotal: 0, feeByStore: {}, overLimitStoreIds: [] };
  const hasMax = typeof cfg.maxPerPackagePKR === 'number' && cfg.maxPerPackagePKR > 0;
  const hasFee = cfg.feePerPackagePKR > 0;
  if (!hasMax && !hasFee) return base;
  let max: number | null = null;
  let fee = 0;
  let packages: CodPackage[] = [];
  try {
    if (hasMax) max = round2(convert(cfg.maxPerPackagePKR as number, 'PKR', checkout.currency));
    if (hasFee) fee = round2(convert(cfg.feePerPackagePKR, 'PKR', checkout.currency));
    packages = hasMax ? codPackagesOf(checkout, convert) : [];
  } catch {
    // No usable rate on this checkout: refuse COD rather than guess an amount.
    return { ...base, available: false, reason: 'Cash on Delivery is temporarily unavailable. Please pay online.' };
  }
  const over = max != null ? packages.filter((p) => p.total > max!) : [];
  return {
    available: over.length === 0,
    reason: over.length
      ? `Cash on Delivery is limited to ${cfg.maxPerPackagePKR} PKR per package (items + delivery). One or more packages in this order are above that - please pay online or split your order.`
      : null,
    maxPerPackage: max,
    feePerPackage: fee,
    packageCount: storeCount,
    feeTotal: round2(fee * feeStores.length),
    feeByStore: fee > 0 ? Object.fromEntries(feeStores.map((s) => [s, fee])) : {},
    overLimitStoreIds: over.map((p) => p.storeId),
  };
}

/**
 * Adds `feePerPackage` to every physical package's shipping line on `checkout` (in memory only - the caller persists
 * it together with the order). Idempotent: a checkout that already carries a COD fee (`codFeeTotal > 0`) is left alone.
 * Returns the new { shippingByStore, shippingFee, totalAmount, codFeeTotal }, or null when nothing was added.
 */
export function withCodFee(checkout: any, feePerPackage: number, feeStoreIds?: string[]): null | { shippingByStore: any[]; shippingFee: number; totalAmount: number; codFeeTotal: number } {
  if (!(feePerPackage > 0)) return null;
  if ((checkout?.codFeeTotal ?? 0) > 0) return null;
  const physical = ((checkout?.items ?? []) as any[]).filter((i) => i.type === 'physical');
  const allStoreIds = [...new Set(physical.map((i) => String(i.storeId)))];
  const storeIds = feeStoreIds ? allStoreIds.filter((s) => feeStoreIds.map(String).includes(s)) : allStoreIds;
  if (!storeIds.length) return null;
  const lines: any[] = ((checkout?.shippingByStore ?? []) as any[]).map((l) => ({ storeId: l.storeId, fee: l.fee, baseFee: l.baseFee, discountPercent: l.discountPercent, giftWrapFee: l.giftWrapFee }));
  // Legacy checkout: one flat shippingFee and no per-store lines -> it belongs to the first physical store.
  if (lines.length === 0 && (checkout?.shippingFee || 0) > 0) {
    lines.push({ storeId: allStoreIds[0], fee: checkout.shippingFee, baseFee: checkout.shippingFee, discountPercent: 0 });
  }
  for (const storeId of storeIds) {
    const line = lines.find((l) => String(l.storeId) === storeId);
    if (line) line.fee = round2((line.fee || 0) + feePerPackage);
    else lines.push({ storeId, fee: feePerPackage, baseFee: 0, discountPercent: 0 });
  }
  const codFeeTotal = round2(feePerPackage * storeIds.length);
  return {
    shippingByStore: lines,
    shippingFee: round2((checkout.shippingFee || 0) + codFeeTotal),
    totalAmount: round2((checkout.totalAmount || 0) + codFeeTotal),
    codFeeTotal,
  };
}
