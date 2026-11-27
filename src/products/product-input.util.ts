import { BadRequestException } from '@nestjs/common';
import { parseDispatchDays } from '../common/dispatch.util';
import { cleanClassRange } from './class-levels';
import { cleanDimensions, ParcelType, PARCEL_TYPES } from '../checkout/shipping-rate.util';
import { AUDIENCES, PRODUCT_LANGUAGES, type Audience, type ProductLanguage } from '../common/edu-filters.const';
import { CURRICULA, DELIVERY_FORMATS, DeliveryFormat, DownloadLimit, LicenseType, LICENSE_OPTION_LABEL, LICENSE_OPTION_NAME } from './schemas/product.schema';

/** 'single_classroom' etc. for a variant that carries a "License" option. */
export function licenseFromVariant(variant: any): string | null {
  const label = (variant?.options ?? []).find((o: any) => o?.name === LICENSE_OPTION_NAME)?.value;
  if (!label) return null;
  return Object.entries(LICENSE_OPTION_LABEL).find(([, l]) => l === label)?.[0] ?? null;
}

/** Physical parcel info for the delivery charge. `forCreate` always sets a parcelType ('standard' when not sent);
 *  otherwise only keys present in the request are returned. Throws 400 on a bad type or size. */
export function cleanParcelMeta(body: Record<string, unknown>, forCreate: boolean): { parcelType?: ParcelType; packageCm?: { l: number; w: number; h: number } | null; dispatchDaysOverride?: number | null } {
  const out: { parcelType?: ParcelType; packageCm?: { l: number; w: number; h: number } | null; dispatchDaysOverride?: number | null } = {};
  // Optional per-product dispatch time (working days, 1-7). null/'' = use the store's. 0 and 8 are rejected.
  if (body.dispatchDaysOverride !== undefined) {
    if (body.dispatchDaysOverride === null || body.dispatchDaysOverride === '') out.dispatchDaysOverride = null;
    else {
      const d = parseDispatchDays(body.dispatchDaysOverride);
      if (d === null || typeof body.dispatchDaysOverride !== 'number') throw new BadRequestException('Dispatch time must be a whole number of days from 1 to 7');
      out.dispatchDaysOverride = d;
    }
  }
  if (body.parcelType !== undefined && body.parcelType !== null && body.parcelType !== '') {
    if (!PARCEL_TYPES.includes(body.parcelType as ParcelType)) throw new BadRequestException('parcelType must be document, standard, fragile or bulky');
    out.parcelType = body.parcelType as ParcelType;
  } else if (forCreate) out.parcelType = 'standard';
  if (body.packageCm !== undefined) {
    try { out.packageCm = cleanDimensions(body.packageCm); } catch (e: any) { throw new BadRequestException(e?.message ?? 'Invalid package size'); }
  }
  return out;
}

/** Board/syllabus list and age range shared by every product type. Only keys
 *  present in the request are returned, so an edit leaves the rest alone. */
export { PRODUCT_LANGUAGES } from '../common/edu-filters.const';

/** Optional book details shown in Details / the facts row. Max lengths of the saved text. */
export const BOOK_DETAIL_LIMITS = { author: 120, publisher: 120, edition: 60 } as const;

/** One optional short text: undefined = not sent (leave alone), ''/null = clear, else trimmed plain text within `max`. */
export function cleanShortText(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text`);
  // Plain text only: tags and control characters are dropped, runs of spaces collapse.
  const clean = v.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new BadRequestException(`${field} can be at most ${max} characters`);
  return clean === '' ? null : clean;
}

export const BOOK_BINDINGS = ['paperback', 'hardcover', 'spiral'] as const;
export const BOOK_PAGES_MAX = 5000;

/** ISBN-10 / ISBN-13 checksum. Takes digits (last char of an ISBN-10 may be X). */
export function isValidIsbn(digits: string): boolean {
  if (/^\d{13}$/.test(digits)) {
    const sum = [...digits].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((s, c, i) => s + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  return false;
}

/** Optional ISBN: undefined = not sent, ''/null = clear, else hyphens/spaces dropped, checksum-validated, stored as digits. */
export function cleanIsbn(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException('isbn must be text');
  const digits = v.replace(/[\s-]/g, '').toUpperCase();
  if (digits === '') return null;
  if (!isValidIsbn(digits)) throw new BadRequestException('isbn must be a valid 10 or 13 digit ISBN');
  return digits;
}

export interface LearningMeta {
  curricula?: string[]; ageMin?: number | null; ageMax?: number | null; classFrom?: string | null; classTo?: string | null;
  coverStyle?: 'book' | 'flat' | null; language?: ProductLanguage | null; audiences?: Audience[];
  author?: string | null; publisher?: string | null; edition?: string | null;
  pages?: number | null; isbn?: string | null; binding?: (typeof BOOK_BINDINGS)[number] | null;
  series?: string | null; seriesOrder?: number | null;
  imageFit?: 'cover' | 'contain';
}

export function cleanLearningMeta(body: Record<string, unknown>): LearningMeta {
  const out: LearningMeta = {};
  if (body.pages !== undefined) {
    const p = body.pages;
    if (p === null || p === '') out.pages = null;
    else if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= BOOK_PAGES_MAX) out.pages = p;
    else throw new BadRequestException(`pages must be a whole number from 1 to ${BOOK_PAGES_MAX}`);
  }
  const isbn = cleanIsbn(body.isbn);
  if (isbn !== undefined) out.isbn = isbn;
  if (body.binding !== undefined) {
    if (body.binding === null || body.binding === '') out.binding = null;
    else if ((BOOK_BINDINGS as readonly unknown[]).includes(body.binding)) out.binding = body.binding as (typeof BOOK_BINDINGS)[number];
    else throw new BadRequestException(`binding must be one of: ${BOOK_BINDINGS.join(', ')}`);
  }
  for (const k of ['author', 'publisher', 'edition'] as const) {
    const v = cleanShortText(body[k], k, BOOK_DETAIL_LIMITS[k]);
    if (v !== undefined) out[k] = v;
  }
  const series = cleanShortText(body.series, 'series', 80);
  if (series !== undefined) out.series = series;
  if (body.seriesOrder !== undefined) {
    const o = body.seriesOrder;
    if (o === null || o === '') out.seriesOrder = null;
    else if (typeof o === 'number' && Number.isInteger(o) && o >= 1 && o <= 999) out.seriesOrder = o;
    else throw new BadRequestException('seriesOrder must be a whole number from 1 to 999');
  }
  if (body.language !== undefined) {
    if (body.language === null || body.language === '') out.language = null;
    else if ((PRODUCT_LANGUAGES as readonly unknown[]).includes(body.language)) out.language = body.language as ProductLanguage;
    else throw new BadRequestException(`language must be one of: ${PRODUCT_LANGUAGES.join(', ')}`);
  }
  if (body.curricula !== undefined) {
    if (!Array.isArray(body.curricula) || body.curricula.length > CURRICULA.length) {
      throw new BadRequestException('curricula must be a list of boards');
    }
    for (const c of body.curricula) {
      if (!(CURRICULA as readonly string[]).includes(c as string)) {
        throw new BadRequestException(`curricula items must be one of: ${CURRICULA.join(', ')}`);
      }
    }
    out.curricula = [...new Set(body.curricula as string[])];
  }
  if (body.audiences !== undefined) {
    if (body.audiences === null) out.audiences = [];
    else {
      if (!Array.isArray(body.audiences) || body.audiences.length > AUDIENCES.length) {
        throw new BadRequestException('audiences must be a list');
      }
      for (const a of body.audiences) {
        if (!(AUDIENCES as readonly unknown[]).includes(a)) {
          throw new BadRequestException(`audiences items must be one of: ${AUDIENCES.join(', ')}`);
        }
      }
      // Stored in the canonical order so equal sets compare equal (edit review, duplicates).
      const picked = new Set(body.audiences as string[]);
      out.audiences = AUDIENCES.filter((a) => picked.has(a));
    }
  }
  const age = (v: unknown, field: string) => {
    if (v === null || v === '') return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 99) {
      throw new BadRequestException(`${field} must be a whole number of years between 0 and 99`);
    }
    return v;
  };
  if (body.ageMin !== undefined) out.ageMin = age(body.ageMin, 'ageMin');
  if (body.ageMax !== undefined) out.ageMax = age(body.ageMax, 'ageMax');
  if (out.ageMin != null && out.ageMax != null && out.ageMin > out.ageMax) {
    throw new BadRequestException('ageMin cannot be more than ageMax');
  }
  // Optional class range (see class-levels.ts); a single side means that one class.
  Object.assign(out, cleanClassRange(body, (m) => new BadRequestException(m)));
  if (body.classFrom !== undefined && body.classTo !== undefined) {
    if (out.classFrom && !out.classTo) out.classTo = out.classFrom;
    if (out.classTo && !out.classFrom) out.classFrom = out.classTo;
  }
  if (body.coverStyle !== undefined) {
    if (body.coverStyle !== null && body.coverStyle !== 'book' && body.coverStyle !== 'flat') {
      throw new BadRequestException('coverStyle must be "book" or "flat"');
    }
    out.coverStyle = body.coverStyle as 'book' | 'flat' | null;
  }
  if (body.imageFit !== undefined) {
    if (body.imageFit !== null && body.imageFit !== 'cover' && body.imageFit !== 'contain') {
      throw new BadRequestException('imageFit must be "cover" or "contain"');
    }
    out.imageFit = body.imageFit === 'contain' ? 'contain' : 'cover';
  }
  return out;
}

/** Extra licenses a digital product can be sold under, each at its own price. */
export function cleanLicenseTiers(raw: unknown): { license: LicenseType; price: number; compareAtPrice: number | null }[] {
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 3) throw new BadRequestException('licenseTiers must be a list of up to 3 licenses');
  const seen = new Set<string>();
  return raw.map((t: any) => {
    if (!t || !Object.values(LicenseType).includes(t.license)) {
      throw new BadRequestException(`licenseTiers[].license must be one of: ${Object.values(LicenseType).join(', ')}`);
    }
    if (seen.has(t.license)) throw new BadRequestException('Each license can only be listed once');
    seen.add(t.license);
    if (typeof t.price !== 'number' || !Number.isFinite(t.price) || t.price < 0 || t.price > 10_000_000) {
      throw new BadRequestException('licenseTiers[].price must be a number from 0 to 10,000,000');
    }
    const cmp = t.compareAtPrice;
    if (cmp !== undefined && cmp !== null && (typeof cmp !== 'number' || !Number.isFinite(cmp) || cmp < 0)) {
      throw new BadRequestException('licenseTiers[].compareAtPrice must be a positive number');
    }
    return { license: t.license, price: t.price, compareAtPrice: cmp ?? null };
  });
}

/** Statuses a seller may put a product in. Kept in sync with the Product schema enum. */
export const SELLER_PRODUCT_STATUSES = [
  'active',
  'inactive',
  'draft',
  'scheduled',
] as const;

/** Set by the admin listing review, never by a seller. */
export const REVIEW_STATUSES = ['pending_review', 'rejected'] as const;

/** New listings need an admin's OK before they go live (education content for
 *  children). On by default; LISTING_APPROVAL_REQUIRED=false turns it off. */
export function listingApprovalRequired(): boolean {
  return process.env.LISTING_APPROVAL_REQUIRED !== 'false';
}

/**
 * Owner rule: free and free-trial stores need admin approval for new listings; stores with a PAID plan that is
 * currently active publish directly. Anything else (no plan, trialing, expired, canceled, past due) is reviewed.
 */
export function sellerSkipsListingReview(
  active: { subscription?: { status?: string | null } | null; plan?: { isFree?: boolean | null } | null } | null | undefined,
): boolean {
  return !!active?.plan && active.plan.isFree !== true && active.subscription?.status === 'active';
}

/**
 * The status a seller's publish request actually gets. Asking to publish
 * (active/scheduled) a listing that was never approved sends it to review
 * instead. A listing that is already live counts as approved, so existing
 * products and edits to approved ones are never held back.
 */
export function resolveSellerPublishStatus(
  requested: (typeof SELLER_PRODUCT_STATUSES)[number],
  current?: { status?: string | null; approvedAt?: Date | null } | null,
  /** The store is on a paid platform plan: its listings go live without admin review (see sellerSkipsListingReview). */
  paidPlan = false,
  /** The product's category requires review (Category.requiresListingReview): beats the paid plan and the global switch. */
  categoryRequiresReview = false,
): string {
  const wantsLive = requested === 'active' || requested === 'scheduled';
  if (!wantsLive) return requested;
  const approved = !!current?.approvedAt || current?.status === 'active' || current?.status === 'scheduled';
  if (categoryRequiresReview) return approved ? requested : 'pending_review';
  if (!listingApprovalRequired() || paidPlan) return requested;
  return approved ? requested : 'pending_review';
}

const ONE_YEAR_MS = 366 * 24 * 60 * 60 * 1000;

export function assertSellerStatus(
  status: unknown,
): asserts status is (typeof SELLER_PRODUCT_STATUSES)[number] {
  if (
    typeof status !== 'string' ||
    !(SELLER_PRODUCT_STATUSES as readonly string[]).includes(status)
  ) {
    throw new BadRequestException(
      `status must be one of: ${SELLER_PRODUCT_STATUSES.join(', ')}`,
    );
  }
}

/**
 * A scheduled product needs a real, future (within a year) date. Invalid dates used to reach Mongoose
 * as `Invalid Date` and surface as a 500; past dates silently published on the next cron tick.
 */
export function parseScheduledAt(scheduledAt: unknown, now = new Date()): Date {
  if (scheduledAt === undefined || scheduledAt === null || scheduledAt === '') {
    throw new BadRequestException(
      'scheduledAt is required when status is scheduled',
    );
  }
  const date = new Date(scheduledAt as string | number);
  if (Number.isNaN(date.getTime()))
    throw new BadRequestException('scheduledAt is not a valid date');
  if (date.getTime() <= now.getTime())
    throw new BadRequestException('scheduledAt must be in the future');
  if (date.getTime() > now.getTime() + ONE_YEAR_MS)
    throw new BadRequestException('scheduledAt must be within one year');
  return date;
}

export function assertStringArray(
  value: unknown,
  field: string,
  { maxItems, maxLength }: { maxItems: number; maxLength: number },
): string[] {
  if (!Array.isArray(value))
    throw new BadRequestException(`${field} must be an array`);
  if (value.length > maxItems)
    throw new BadRequestException(
      `${field} can have at most ${maxItems} items`,
    );
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLength) {
      throw new BadRequestException(
        `${field} items must be non-empty strings of at most ${maxLength} characters`,
      );
    }
  }
  return value as string[];
}

export function assertText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string')
    throw new BadRequestException(`${field} must be a string`);
  if (value.length > maxLength)
    throw new BadRequestException(
      `${field} must be at most ${maxLength} characters`,
    );
  return value;
}

export interface CleanDigitalSettings {
  downloadLimit: DownloadLimit;
  linkExpiryDays: number | null;
  pdfStampingEnabled: boolean;
  licenseType: LicenseType;
  buyerDeliveryMessage: string | null;
  preview: { enabled: boolean; sourceFileIndex: number | null };
}

/**
 * Whitelists and bounds-checks the NON-file parts of a digital config. Only these keys survive
 * (unknown keys and the server-managed `preview.previewSource*` are dropped), and `linkExpiryDays`
 * is an integer 1–3650 or null — it used to accept 0, negatives, NaN and 1e9 on edit.
 */
export function cleanDigitalSettings(
  raw: Record<string, unknown>,
  existing?: Partial<CleanDigitalSettings> | null,
): CleanDigitalSettings {
  const downloadLimit =
    raw.downloadLimit ?? existing?.downloadLimit ?? DownloadLimit.UNLIMITED;
  if (!Object.values(DownloadLimit).includes(downloadLimit as DownloadLimit)) {
    throw new BadRequestException(
      `downloadLimit must be one of: ${Object.values(DownloadLimit).join(', ')}`,
    );
  }

  let linkExpiryDays: number | null = existing?.linkExpiryDays ?? null;
  if (raw.linkExpiryDays !== undefined) {
    if (raw.linkExpiryDays === null) linkExpiryDays = null;
    else if (
      typeof raw.linkExpiryDays === 'number' &&
      Number.isInteger(raw.linkExpiryDays) &&
      raw.linkExpiryDays >= 1 &&
      raw.linkExpiryDays <= 3650
    ) {
      linkExpiryDays = raw.linkExpiryDays;
    } else
      throw new BadRequestException(
        'linkExpiryDays must be a whole number of days between 1 and 3650, or null',
      );
  }

  const licenseType =
    raw.licenseType ?? existing?.licenseType ?? LicenseType.PERSONAL;
  if (!Object.values(LicenseType).includes(licenseType as LicenseType)) {
    throw new BadRequestException(
      `licenseType must be one of: ${Object.values(LicenseType).join(', ')}`,
    );
  }

  let pdfStampingEnabled = existing?.pdfStampingEnabled ?? false;
  if (raw.pdfStampingEnabled !== undefined) {
    if (typeof raw.pdfStampingEnabled !== 'boolean')
      throw new BadRequestException('pdfStampingEnabled must be a boolean');
    pdfStampingEnabled = raw.pdfStampingEnabled;
  }

  let buyerDeliveryMessage: string | null =
    existing?.buyerDeliveryMessage ?? null;
  if (raw.buyerDeliveryMessage !== undefined) {
    buyerDeliveryMessage =
      raw.buyerDeliveryMessage === null
        ? null
        : assertText(raw.buyerDeliveryMessage, 'buyerDeliveryMessage', 2000);
  }

  const rawPreview = (raw.preview ?? {}) as Record<string, unknown>;
  const enabled = rawPreview.enabled === true;
  let sourceFileIndex: number | null = null;
  if (enabled) {
    const idx = rawPreview.sourceFileIndex ?? 0;
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx > 99
    ) {
      throw new BadRequestException(
        'preview.sourceFileIndex must be a whole number',
      );
    }
    sourceFileIndex = idx;
  }

  return {
    downloadLimit: downloadLimit as DownloadLimit,
    linkExpiryDays,
    pdfStampingEnabled,
    licenseType: licenseType as LicenseType,
    buyerDeliveryMessage,
    preview: { enabled, sourceFileIndex },
  };
}

/**
 * `deliveryFormat` from a create or edit body. Live classes are retired:
 * 'live_class' is just an invalid value now (with a clear message).
 */
export function cleanDeliveryFormat(
  body: Record<string, unknown>,
  _existing?: { deliveryFormat?: string | null } | null,
): { deliveryFormat?: DeliveryFormat } {
  const out: { deliveryFormat?: DeliveryFormat } = {};
  if (body.deliveryFormat !== undefined) {
    if (body.deliveryFormat === 'live_class') {
      throw new BadRequestException('Live classes are no longer available. Choose files to download or an online course.');
    }
    if (!(DELIVERY_FORMATS as readonly string[]).includes(body.deliveryFormat as string)) {
      throw new BadRequestException(`deliveryFormat must be one of: ${DELIVERY_FORMATS.join(', ')}`);
    }
    out.deliveryFormat = body.deliveryFormat as DeliveryFormat;
  }
  return out;
}