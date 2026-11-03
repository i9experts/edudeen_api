import { parseWeightKg } from '../products/price-rules.util';

/**
 * One store's checkout lines -> the numbers the rate engine needs.
 * real weight = sum(unit weight x qty); volumetric = sum(L x W x H / divisor x qty); billable = the larger.
 * A line with no weight on record counts as 0.5 kg so a missing weight never makes delivery free.
 */
export const FALLBACK_UNIT_KG = 0.5;

export function parcelTotals(
  storeItems: Array<{ productId: any; variantId: any; quantity?: number }>,
  info: { products: Map<string, any>; variants: Map<string, any> },
  divisor: number,
): { billableKg: number; fragile: boolean } {
  let real = 0;
  let volumetric = 0;
  let fragile = false;
  for (const it of storeItems) {
    const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
    const product = info.products.get(String(it.productId));
    const variant = info.variants.get(String(it.variantId));
    real += (parseWeightKg(variant?.shippingWeight) ?? FALLBACK_UNIT_KG) * qty;
    const d = product?.packageCm;
    if (d?.l && d?.w && d?.h) volumetric += ((d.l * d.w * d.h) / divisor) * qty;
    if (product?.parcelType === 'fragile') fragile = true;
  }
  return { billableKg: Math.round(Math.max(real, volumetric) * 1e6) / 1e6, fragile };
}
