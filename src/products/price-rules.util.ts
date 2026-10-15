import { BadRequestException } from '@nestjs/common';

/**
 * Seller price / description rules. Mirrors edudeen_web/.../products/priceRules.ts (the seller forms and bulk upload use
 * the web copy for instant feedback; this is the authority). Throws 400 with a seller-facing message.
 */
export const MIN_DESCRIPTION_LENGTH = 20;

const decimalsOf = (n: number) => {
  const s = String(n);
  if (s.includes('e')) return 99;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

function assertDecimals(n: number, currency: string | null | undefined, label: string) {
  if (currency === 'PKR') {
    if (!Number.isInteger(n)) throw new BadRequestException(`${label} in PKR must be whole rupees (no decimals).`);
  } else if (decimalsOf(n) > 2) {
    throw new BadRequestException(`${label} can have at most 2 decimals.`);
  }
}

/**
 * price: negative, currency decimals; compareAtPrice (when a number): negative, decimals and strictly above price.
 * Non-numbers are left to the existing type check. A price of 0 stays allowed (free products exist; the API cannot
 * tell an explicit "free" from a typo, the seller UIs do).
 */
export function assertPriceRules(input: { price?: unknown; compareAtPrice?: unknown; currency?: string | null; priceLabel?: string }): void {
  const priceLabel = input.priceLabel ?? 'Price';
  const price = typeof input.price === 'number' && Number.isFinite(input.price) ? input.price : null;
  if (price !== null) {
    if (price < 0) throw new BadRequestException(`${priceLabel} can't be negative`);
    assertDecimals(price, input.currency, `${priceLabel}s`);
  }
  const c = input.compareAtPrice;
  if (typeof c === 'number' && Number.isFinite(c)) {
    if (c < 0) throw new BadRequestException("Compare-at price can't be negative");
    assertDecimals(c, input.currency, 'Compare-at prices');
    if (price !== null && !(c > price)) throw new BadRequestException('Compare-at must be higher than price');
  }
}

/** Description is required and at least MIN_DESCRIPTION_LENGTH characters once trimmed. Returns the value. */
export function assertDescriptionRule(description: unknown): void {
  if (description === undefined || description === null || !String(description).trim()) {
    throw new BadRequestException('description is required');
  }
  const len = String(description).trim().length;
  if (len < MIN_DESCRIPTION_LENGTH) {
    throw new BadRequestException(`Description must be at least ${MIN_DESCRIPTION_LENGTH} characters (now ${len})`);
  }
}

export const MAX_WEIGHT_KG = 50;
export const MIN_WEIGHT_KG = 0.001; // 1 g
export const MAX_STOCK = 100_000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** "0.6 kg", "600 g", "500g", "0.6" (kg) -> kilograms; null when it is not a (non-negative) weight. */
export function parseWeightKg(text: unknown): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kg|g)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return r6((m[2] ?? 'kg').toLowerCase() === 'g' ? n / 1000 : n);
}

/**
 * Validates a physical variant's shippingWeight and returns the normalized stored text ("0.25 kg"), or undefined when
 * the field was not sent and is not required. `required` = create (always) - on update it is only checked when sent.
 */
export function cleanShippingWeight(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined && !required) return undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') throw new BadRequestException('Shipping weight is required');
  if (/^\s*-\s*\d/.test(String(raw))) throw new BadRequestException("Shipping weight can't be negative");
  const kg = parseWeightKg(raw);
  if (kg === null) throw new BadRequestException('Shipping weight must be a number, e.g. 0.5 kg or 500 g');
  if (kg < MIN_WEIGHT_KG - 1e-12) throw new BadRequestException('Minimum weight is 1 g');
  if (kg > MAX_WEIGHT_KG) throw new BadRequestException(`Shipping weight can't be more than ${MAX_WEIGHT_KG} kg`);
  return `${kg} kg`;
}
/** Stock: whole number 0..MAX_STOCK (skipped for unlimited stock). */
export function assertStockRule(stock: unknown, unlimited: boolean): void {
  if (unlimited || stock === undefined || stock === null) return;
  if (typeof stock !== 'number' || !Number.isFinite(stock)) throw new BadRequestException('Stock must be a whole number');
  if (stock < 0) throw new BadRequestException("Stock can't be negative");
  if (!Number.isInteger(stock)) throw new BadRequestException('Stock must be a whole number');
  if (stock > MAX_STOCK) throw new BadRequestException(`Stock can't be more than ${MAX_STOCK.toLocaleString('en-US')}`);
}
