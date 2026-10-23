/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

/** What the first bytes of a file say it is - never what the client declared. */
export type SniffedKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'heif' | 'pdf' | 'zip' | 'ole' | 'unknown';

const MIME_BY_KIND: Partial<Record<SniffedKind, string>> = {
  jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heif: 'image/heic', pdf: 'application/pdf',
};

const startsWith = (b: Buffer, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

export function sniffKind(buf: Buffer | undefined | null): SniffedKind {
  if (!buf || buf.length < 4) return 'unknown';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  if (ascii(buf, 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(ascii(buf, 8, 12))) return 'heif';
  // %PDF may be preceded by a few junk bytes in real files; the spec allows the header in the first 1 KB.
  if (buf.subarray(0, Math.min(buf.length, 1024)).includes('%PDF-')) return 'pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  return 'unknown';
}

/** True when the content is markup/script (HTML, SVG, XML, JS) - a polyglot hiding behind a "safe" extension. */
export function looksLikeMarkup(buf: Buffer | undefined | null): boolean {
  if (!buf) return false;
  const head = buf.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return /^(<!doctype html|<html|<head|<body|<svg|<\?xml|<script|<iframe|<meta|<!--)/.test(head) || /<script[\s>]/.test(head);
}

const IMAGE_KINDS: SniffedKind[] = ['jpeg', 'png', 'gif', 'webp', 'heif'];
const EXT_KINDS: Record<string, SniffedKind[]> = {
  jpg: ['jpeg'], jpeg: ['jpeg'], png: ['png'], gif: ['gif'], webp: ['webp'],
  avif: ['heif'], heic: ['heif'], pdf: ['pdf'],
};

/**
 * Content check for an upload. Images and PDFs must really be what their extension says (magic bytes); anything
 * else must at least not be disguised markup. Returns the sniffed MIME for images/PDFs so callers can ignore
 * whatever the client sent. Throws 400 on a mismatch.
 */
export function assertFileContent(file: { originalname?: string; buffer?: Buffer }, opts: { allowMarkup?: boolean } = {}): string | null {
  const ext = (file.originalname?.split('.').pop() ?? '').toLowerCase();
  const expected = EXT_KINDS[ext];
  const kind = sniffKind(file.buffer);
  if (expected) {
    if (!expected.includes(kind)) throw new BadRequestException(`The file is not a real .${ext} file`);
    return MIME_BY_KIND[kind] ?? null;
  }
  if (IMAGE_KINDS.includes(kind) || kind === 'pdf') {
    // e.g. an image/PDF renamed to .docx / .txt - harmless to store but the extension is lying.
    throw new BadRequestException(`The file content does not match its .${ext || '?'} extension`);
  }
  if (!opts.allowMarkup && looksLikeMarkup(file.buffer)) throw new BadRequestException('This file type is not allowed');
  return null;
}

/** Banner / slide images: jpg, png or webp only, judged by content. Returns the real MIME. */
export function assertRasterImage(file: { buffer?: Buffer }): string {
  const kind = sniffKind(file.buffer);
  if (kind !== 'jpeg' && kind !== 'png' && kind !== 'webp') throw new BadRequestException('Only real jpg, png or webp images are allowed');
  return MIME_BY_KIND[kind] as string;
}