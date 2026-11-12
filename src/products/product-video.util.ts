import { BadRequestException } from '@nestjs/common';

/** One optional product video (uploaded by the seller). `frontFirst` = the video is the first slide of the product page gallery. */
export interface ProductVideo {
  url: string;
  posterUrl: string | null;
  frontFirst: boolean;
}

const CLOUDINARY_VIDEO = /^https:\/\/res\.cloudinary\.com\/[^/\s]+\/video\/upload\/[^\s]+$/i;
const CLOUDINARY_ANY = /^https:\/\/res\.cloudinary\.com\/[^/\s]+\/(image|video)\/upload\/[^\s]+$/i;

/** A poster (still frame) URL Cloudinary can render from a video URL: first second, 900 px wide, jpg. */
export function posterFromVideoUrl(url: string): string | null {
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/\s]+\/video\/upload\/)(.+?)(\.[a-z0-9]{2,4})?$/i.exec(url);
  if (!m) return null;
  return `${m[1]}so_1,w_900,c_limit,q_auto,f_jpg/${m[2]}.jpg`;
}

/**
 * Validates the `video` field of a create/edit body.
 * undefined = not sent (callers keep the stored value); null / '' / {} without url = remove the video.
 */
export function cleanProductVideo(input: unknown): ProductVideo | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === '') return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('video must be an object');
  const v = input as Record<string, unknown>;
  if (v.url === undefined || v.url === null || v.url === '') return null;
  if (typeof v.url !== 'string' || v.url.length > 2048 || !CLOUDINARY_VIDEO.test(v.url)) {
    throw new BadRequestException('Product video must be a video uploaded through Edudeen');
  }
  let posterUrl: string | null = null;
  if (typeof v.posterUrl === 'string' && v.posterUrl) {
    if (v.posterUrl.length > 2048 || !CLOUDINARY_ANY.test(v.posterUrl)) throw new BadRequestException('Invalid video poster');
    posterUrl = v.posterUrl;
  } else {
    posterUrl = posterFromVideoUrl(v.url);
  }
  return { url: v.url, posterUrl, frontFirst: v.frontFirst === true };
}

/** Real container check by the first bytes: MP4/MOV ('ftyp' box) or WebM/Matroska (EBML header). */
export function sniffVideo(buf: Buffer | undefined | null): 'mp4' | 'webm' | null {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}
