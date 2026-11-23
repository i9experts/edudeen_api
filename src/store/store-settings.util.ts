import { BadRequestException } from '@nestjs/common';
import { PK_PROVINCES } from '../address/address.service';

/**
 * update-store field rules shared by the web and the app (app backend gap #3).
 * Each helper returns the value to store or throws a 400 with a readable message.
 */

/** productTypes, when sent, must be a non-empty list (an empty list leaves a store that sells nothing). */
export function cleanStoreProductTypes(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) throw new BadRequestException('productTypes must be a list');
  if (!raw.length) throw new BadRequestException('Choose at least one product type for your store');
  for (const pt of raw) {
    if (typeof pt !== 'string' || !allowed.includes(pt)) {
      throw new BadRequestException(`Invalid productType: ${String(pt)}. Allowed: ${allowed.join(', ')}`);
    }
  }
  return [...new Set(raw as string[])];
}

/** codEnabled must be a real boolean ("x" used to be saved as true). */
export function cleanCodEnabled(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new BadRequestException('codEnabled must be true or false');
  return raw;
}

/**
 * shipFrom { city, province? }. null / an empty city with no province clears it. A province must be one of the
 * Pakistani provinces used by addresses (matched case-insensitively, stored with its canonical spelling) and
 * needs a city.
 */
export function cleanShipFrom(raw: unknown): { city: string; province: string | null } | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('shipFrom must be an object');
  const sf = raw as { city?: unknown; province?: unknown };
  if (sf.city != null && typeof sf.city !== 'string') throw new BadRequestException('shipFrom.city must be text');
  if (sf.province != null && typeof sf.province !== 'string') {
    throw new BadRequestException(`shipFrom.province must be one of: ${PK_PROVINCES.join(', ')}`);
  }
  const city = String(sf.city ?? '').trim();
  const provinceRaw = String(sf.province ?? '').trim();
  if (!city && !provinceRaw) return null;
  if (!city) throw new BadRequestException('Choose the city you ship from for this province');
  if (city.length > 60) throw new BadRequestException('shipFrom.city must be at most 60 characters');
  let province: string | null = null;
  if (provinceRaw) {
    province = PK_PROVINCES.find((p) => p.toLowerCase() === provinceRaw.toLowerCase()) ?? null;
    if (!province) throw new BadRequestException(`shipFrom.province must be one of: ${PK_PROVINCES.join(', ')}`);
  }
  return { city, province };
}
