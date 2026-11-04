import { BadRequestException } from '@nestjs/common';

/** Fixed reasons a buyer can pick; the label is what sellers/admins read. */
export const REFUND_REASON_CODES = {
  damaged: 'Item arrived damaged',
  wrong_item: 'Wrong item received',
  incomplete: 'Incomplete (missing parts or pages)',
  not_as_described: 'Not as described',
  cant_access_file: "Can't access the digital file",
} as const;
export type RefundReasonCode = keyof typeof REFUND_REASON_CODES;

export const REFUND_NOTE_MIN = 20;
export const REFUND_NOTE_MAX = 1000;
export const REFUND_MAX_IMAGES = 3;

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
  if (dto.reasonCode === 'cant_access_file' && hasPhysical) {
    throw new BadRequestException('"Can\'t access the digital file" only applies to digital items');
  }
  if (images.length && !hasPhysical) throw new BadRequestException('Photos can only be added for physical items');
  return { reasonCode: dto.reasonCode, note, evidenceImages: images };
}
