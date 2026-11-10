import { BadRequestException } from '@nestjs/common';

/**
 * The ONE reason list for refunds and returns (web mirror: api/services/refundRequests.ts).
 * The label is what sellers/admins read. New requests may only use these codes.
 */
export const REFUND_REASON_CODES = {
  damaged: 'Item arrived damaged',
  missing_pages: 'Missing pages or parts',
  printing_error: 'Printing error',
  wrong_item: 'Wrong item received',
  wrong_edition_or_class: 'Wrong edition or class',
  not_as_described: 'Not as described',
  digital_not_working: 'Digital file is not working',
  other: 'Other',
} as const;
export type RefundReasonCode = keyof typeof REFUND_REASON_CODES;

/** Codes stored by earlier versions: still DISPLAYED as written, never accepted for new requests. */
export const LEGACY_REASON_LABELS: Record<string, string> = {
  incomplete: 'Incomplete (missing parts or pages)',
  cant_access_file: "Can't access the digital file",
};

/** Label for display: current list, then legacy codes, then the free text exactly as stored. */
export function reasonDisplayLabel(code: string | null | undefined, freeText: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(REFUND_REASON_CODES, code)) return REFUND_REASON_CODES[code as RefundReasonCode];
  if (code && LEGACY_REASON_LABELS[code]) return LEGACY_REASON_LABELS[code];
  return String(freeText ?? '').trim();
}

export const REFUND_NOTE_MIN = 20;
export const REFUND_NOTE_MAX = 1000;
export const REFUND_MAX_IMAGES = 4;
/** A rejection must say why (shown to the buyer). */
export const REJECT_REASON_MIN = 10;

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|avif)$/i;

function allowedHosts(): string[] {
  const extra = (process.env.PUBLIC_ASSET_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return ['res.cloudinary.com', ...extra];
}

export function isRefundReasonCode(v: unknown): v is RefundReasonCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(REFUND_REASON_CODES, v);
}

/**
 * Evidence photos come from the existing public upload route, which sniffs the
 * bytes and stores real images under `/image/upload/` (anything else lands in
 * `/raw/upload/`). So: https, our asset host, image path, image extension.
 */
export function cleanEvidenceImages(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('Photos must be a list');
  if (raw.length > REFUND_MAX_IMAGES) throw new BadRequestException(`You can add up to ${REFUND_MAX_IMAGES} photos`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v.length > 500) throw new BadRequestException('Each photo must be an uploaded image link');
    let u: URL;
    try { u = new URL(v.trim()); } catch { throw new BadRequestException('Each photo must be an uploaded image link'); }
    if (
      u.protocol !== 'https:' || u.username || u.password ||
      !allowedHosts().includes(u.hostname.toLowerCase()) ||
      !u.pathname.includes('/image/upload/') ||
      !IMAGE_EXT.test(u.pathname)
    ) {
      throw new BadRequestException('Only image files (JPG, PNG, WebP) uploaded through Edudeen can be added as photos');
    }
    const url = u.toString();
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** Validates reasonCode / note / images together with the type of the requested items. */
export function cleanRefundEvidence(
  dto: { reasonCode?: string; note?: string; evidenceImages?: unknown },
  itemTypes: string[],
): { reasonCode: RefundReasonCode | null; note: string | null; evidenceImages: string[] } {
  const images = cleanEvidenceImages(dto.evidenceImages);
  const note = typeof dto.note === 'string' ? dto.note.trim() : '';
  if (dto.reasonCode === undefined || dto.reasonCode === null || dto.reasonCode === '') {
    if (note || images.length) throw new BadRequestException('Choose a reason before adding a note or photos');
    return { reasonCode: null, note: null, evidenceImages: [] };
  }
  if (!isRefundReasonCode(dto.reasonCode)) throw new BadRequestException('Choose one of the listed reasons');
  if (note.length < REFUND_NOTE_MIN || note.length > REFUND_NOTE_MAX) {
    throw new BadRequestException(`Please describe the problem in ${REFUND_NOTE_MIN}-${REFUND_NOTE_MAX} characters`);
  }
  const hasPhysical = itemTypes.some((t) => t !== 'digital');
  if (dto.reasonCode === 'digital_not_working' && hasPhysical) {
    throw new BadRequestException('"Digital file is not working" only applies to digital items');
  }
  if (images.length && !hasPhysical) throw new BadRequestException('Photos can only be added for physical items');
  return { reasonCode: dto.reasonCode, note, evidenceImages: images };
}
