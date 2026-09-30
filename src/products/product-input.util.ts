import { BadRequestException } from '@nestjs/common';
import { DownloadLimit, LicenseType } from './schemas/product.schema';

/** Statuses a seller may put a product in. Kept in sync with the Product schema enum. */
export const SELLER_PRODUCT_STATUSES = [
  'active',
  'inactive',
  'draft',
  'scheduled',
] as const;

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
