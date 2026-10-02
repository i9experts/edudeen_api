import { BadRequestException } from '@nestjs/common';
import { CURRICULA, DELIVERY_FORMATS, DeliveryFormat, DownloadLimit, LicenseType, LICENSE_OPTION_LABEL, LICENSE_OPTION_NAME, LIVE_PLATFORMS } from './schemas/product.schema';

/** 'single_classroom' etc. for a variant that carries a "License" option. */
export function licenseFromVariant(variant: any): string | null {
  const label = (variant?.options ?? []).find((o: any) => o?.name === LICENSE_OPTION_NAME)?.value;
  if (!label) return null;
  return Object.entries(LICENSE_OPTION_LABEL).find(([, l]) => l === label)?.[0] ?? null;
}

/** Board/syllabus list and age range shared by every product type. Only keys
 *  present in the request are returned, so an edit leaves the rest alone. */
export function cleanLearningMeta(body: Record<string, unknown>): { curricula?: string[]; ageMin?: number | null; ageMax?: number | null } {
  const out: { curricula?: string[]; ageMin?: number | null; ageMax?: number | null } = {};
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
 * The status a seller's publish request actually gets. Asking to publish
 * (active/scheduled) a listing that was never approved sends it to review
 * instead. A listing that is already live counts as approved, so existing
 * products and edits to approved ones are never held back.
 */
export function resolveSellerPublishStatus(
  requested: (typeof SELLER_PRODUCT_STATUSES)[number],
  current?: { status?: string | null; approvedAt?: Date | null } | null,
): string {
  const wantsLive = requested === 'active' || requested === 'scheduled';
  if (!wantsLive || !listingApprovalRequired()) return requested;
  const approved = !!current?.approvedAt || current?.status === 'active' || current?.status === 'scheduled';
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
 * `deliveryFormat` / `liveSession` from a create or edit body. A live class
 * needs a start time (in the future when it's being set or moved), a sensible
 * length and an https meeting link. `existing` is the product being edited.
 */
export function cleanDeliveryFormat(
  body: Record<string, unknown>,
  existing: { deliveryFormat?: string | null; liveSession?: any } | null,
): { deliveryFormat?: DeliveryFormat; liveSession?: any } {
  const out: { deliveryFormat?: DeliveryFormat; liveSession?: any } = {};
  if (body.deliveryFormat !== undefined) {
    if (!(DELIVERY_FORMATS as readonly string[]).includes(body.deliveryFormat as string)) {
      throw new BadRequestException(`deliveryFormat must be one of: ${DELIVERY_FORMATS.join(', ')}`);
    }
    out.deliveryFormat = body.deliveryFormat as DeliveryFormat;
  }
  const format = out.deliveryFormat ?? existing?.deliveryFormat ?? 'download';
  if (format !== 'live_class') {
    if (out.deliveryFormat !== undefined) out.liveSession = null;
    return out;
  }
  if (body.liveSession === undefined) {
    if (!existing?.liveSession) throw new BadRequestException('A live class needs a date, time and meeting link');
    return out;
  }
  const raw = body.liveSession as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new BadRequestException('A live class needs a date, time and meeting link');
  const startsAt = new Date(raw.startsAt as string);
  if (Number.isNaN(startsAt.getTime())) throw new BadRequestException('Pick when the live class starts');
  const prevStart = existing?.liveSession?.startsAt ? new Date(existing.liveSession.startsAt).getTime() : null;
  if (startsAt.getTime() !== prevStart && startsAt.getTime() < Date.now()) throw new BadRequestException('The live class must start in the future');
  const durationMinutes = Number(raw.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 600) {
    throw new BadRequestException('Class length should be between 15 minutes and 10 hours');
  }
  const meetingUrl = typeof raw.meetingUrl === 'string' ? raw.meetingUrl.trim() : '';
  let url: URL | null = null;
  try { url = new URL(meetingUrl); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || meetingUrl.length > 500) throw new BadRequestException('Add the https:// meeting link (Zoom, Google Meet, Teams…)');
  const platform = (LIVE_PLATFORMS as readonly string[]).includes(raw.platform as string) ? (raw.platform as string) : 'other';
  let capacity: number | null = null;
  if (raw.capacity !== undefined && raw.capacity !== null && raw.capacity !== '') {
    capacity = Number(raw.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new BadRequestException('Seats should be between 1 and 10,000 (or leave empty for no limit)');
  }
  const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 1000) : '';
  out.liveSession = { startsAt, durationMinutes, platform, meetingUrl, capacity, notes };
  return out;
}