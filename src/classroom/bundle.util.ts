/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { BUNDLE_MAX_ITEMS, BUNDLE_MAX_PERCENT, BUNDLE_MIN_ITEMS, BUNDLE_MIN_PERCENT } from './schemas/bundle.schema';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const round = (n: number) => Math.round(n * 100) / 100;

/** Validates the seller's bundle form. Product ownership is checked separately (needs the DB). */
export function cleanBundleInput(body: any, partial = false) {
  const out: { name?: string; description?: string; productIds?: string[]; discountPercent?: number; isActive?: boolean } = {};
  if (!partial || body?.name !== undefined) {
    out.name = str(body?.name, 100);
    if (!out.name) throw new BadRequestException('Give the bundle a name');
  }
  if (body?.description !== undefined) out.description = str(body.description, 1000);
  if (!partial || body?.productIds !== undefined) {
    const ids = Array.isArray(body?.productIds) ? [...new Set(body.productIds.filter((x: unknown) => typeof x === 'string' && isValidObjectId(x)))] as string[] : [];
    if (ids.length < BUNDLE_MIN_ITEMS) throw new BadRequestException(`A bundle needs at least ${BUNDLE_MIN_ITEMS} different products`);
    if (ids.length > BUNDLE_MAX_ITEMS) throw new BadRequestException(`A bundle can hold up to ${BUNDLE_MAX_ITEMS} products`);
    out.productIds = ids;
  }
  if (!partial || body?.discountPercent !== undefined) {
    const pct = Number(body?.discountPercent);
    if (!Number.isFinite(pct) || pct < BUNDLE_MIN_PERCENT || pct > BUNDLE_MAX_PERCENT) {
      throw new BadRequestException(`Bundle discount should be between ${BUNDLE_MIN_PERCENT}% and ${BUNDLE_MAX_PERCENT}%`);
    }
    out.discountPercent = Math.round(pct);
  }
  if (typeof body?.isActive === 'boolean') out.isActive = body.isActive;
  return out;
}

/**
 * The discount a bundle earns on a store's cart lines: only when every bundle
 * product is present, and only for as many complete sets as the cart holds
 * (3 × A + 1 × B is one set, not three). Lines are `{ productId, quantity, totalPrice }`.
 */
export function bundleSavings(bundle: { productIds: string[]; discountPercent: number }, lines: { productId: string; quantity: number; totalPrice: number }[]) {
  const byProduct = new Map<string, { quantity: number; totalPrice: number }>();
  for (const l of lines) {
    const cur = byProduct.get(l.productId) ?? { quantity: 0, totalPrice: 0 };
    byProduct.set(l.productId, { quantity: cur.quantity + l.quantity, totalPrice: cur.totalPrice + l.totalPrice });
  }
  if (!bundle.productIds.length || !bundle.productIds.every(id => (byProduct.get(id)?.quantity ?? 0) > 0)) return 0;
  const sets = Math.min(...bundle.productIds.map(id => byProduct.get(id)!.quantity));
  const setValue = bundle.productIds.reduce((s, id) => {
    const p = byProduct.get(id)!;
    return s + (p.totalPrice / p.quantity) * sets;
  }, 0);
  return round(setValue * (Math.min(bundle.discountPercent, 100) / 100));
}
