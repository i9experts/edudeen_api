/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { sniffKind } from './file-signature.util';

/**
 * Store logo / cover rules. ONE place; web mirror = edudeen_web/src/utils/storeProfileRules.ts (keep in step).
 * Type is judged by file CONTENT (magic bytes), size by the real byte length, dimensions by reading the image header
 * (no decoding, so it is cheap).
 */
export const STORE_IMAGE_RULES = {
  logo: { label: 'logo', maxBytes: 2 * 1024 * 1024, minW: 400, minH: 400, ratio: 1, tolerance: 0.1, hint: 'Square, at least 400 x 400, max 2 MB' },
  cover: { label: 'cover', maxBytes: 5 * 1024 * 1024, minW: 1600, minH: 400, ratio: 4, tolerance: 0.1, hint: '1600 x 400 (4:1), max 5 MB' },
} as const;
export type StoreImageKind = keyof typeof STORE_IMAGE_RULES;
export const STORE_IMAGE_PURPOSES: Record<string, StoreImageKind> = { store_logo: 'logo', store_cover: 'cover' };

/** Width x height from the header of a PNG / JPEG / WebP, or null when it cannot be read. */
export function imageDimensions(buf: Buffer | undefined | null): { width: number; height: number } | null {
  if (!buf) return null;
  const kind = sniffKind(buf);
  try {
    if (kind === 'png') {
      if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; } // fill byte
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (kind === 'webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
  } catch {
    return null;
  }
  return null;
}

/** Throws 400 with a plain message when the file is not an acceptable store logo / cover. */
export function assertStoreImage(file: { buffer?: Buffer; size?: number }, kind: StoreImageKind): void {
  const r = STORE_IMAGE_RULES[kind];
  const size = file.size ?? file.buffer?.length ?? 0;
  const k = sniffKind(file.buffer);
  if (k !== 'jpeg' && k !== 'png' && k !== 'webp') throw new BadRequestException(`The ${r.label} must be a real JPG, PNG or WebP image`);
  if (size > r.maxBytes) {
    throw new BadRequestException(`The ${r.label} is ${(size / 1048576).toFixed(1)} MB. The maximum is ${r.maxBytes / 1048576} MB`);
  }
  const d = imageDimensions(file.buffer);
  if (!d || !d.width || !d.height) throw new BadRequestException(`Could not read the size of this ${r.label} image. Try saving it again as JPG or PNG`);
  if (d.width < r.minW || d.height < r.minH) {
    throw new BadRequestException(`The ${r.label} is ${d.width} x ${d.height}. It must be at least ${r.minW} x ${r.minH}`);
  }
  const ratio = d.width / d.height;
  if (Math.abs(ratio - r.ratio) / r.ratio > r.tolerance) {
    throw new BadRequestException(`The ${r.label} is ${d.width} x ${d.height}. ${r.ratio === 1 ? 'It must be square' : 'It must be wide, 4:1 (for example 1600 x 400)'}`);
  }
}
