import { BadRequestException } from '@nestjs/common';
import { UploadController } from '../upload/upload.controller';
import { assertStoreImage, imageDimensions, STORE_IMAGE_RULES } from './store-image.util';

/** Smallest buffers that carry a real magic number + the size fields the checker reads. `pad` makes the file bigger. */
function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  // SOI, APP0 (len 16), SOF0 (len 17): precision, height, width
  const b = Buffer.alloc(2 + 18 + 19);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(16, 4);
  b[20] = 0xff; b[21] = 0xc0; b.writeUInt16BE(17, 22); b[24] = 8; b.writeUInt16BE(h, 25); b.writeUInt16BE(w, 27);
  return b;
}
function webpLossless(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1');
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}
const file = (buffer: Buffer) => ({ buffer, size: buffer.length, originalname: 'x.png' });

describe('imageDimensions', () => {
  it('reads PNG, JPEG and WebP headers', () => {
    expect(imageDimensions(png(1600, 400))).toEqual({ width: 1600, height: 400 });
    expect(imageDimensions(jpeg(800, 800))).toEqual({ width: 800, height: 800 });
    expect(imageDimensions(webpLossless(1200, 300))).toEqual({ width: 1200, height: 300 });
  });
  it('returns null for junk', () => {
    expect(imageDimensions(Buffer.from('not an image at all'))).toBeNull();
    expect(imageDimensions(undefined)).toBeNull();
  });
});

describe('assertStoreImage', () => {
  it('accepts a good logo and a good cover', () => {
    expect(() => assertStoreImage(file(png(500, 500)), 'logo')).not.toThrow();
    expect(() => assertStoreImage(file(jpeg(1600, 400)), 'cover')).not.toThrow();
    expect(() => assertStoreImage(file(png(1920, 480)), 'cover')).not.toThrow();
  });
  it('a 6 MB cover is refused with a size message', () => {
    const big = png(1600, 400, 6 * 1024 * 1024);
    expect(() => assertStoreImage(file(big), 'cover')).toThrow(/6\.0 MB\. The maximum is 5 MB/);
  });
  it('a 3 MB logo is refused (max 2 MB)', () => {
    expect(() => assertStoreImage(file(png(600, 600, 3 * 1024 * 1024)), 'logo')).toThrow(/maximum is 2 MB/);
  });
  it('wrong type, too small, wrong shape', () => {
    expect(() => assertStoreImage(file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'logo')).toThrow(/real JPG, PNG or WebP/);
    expect(() => assertStoreImage(file(png(300, 300)), 'logo')).toThrow(/at least 400 x 400/);
    expect(() => assertStoreImage(file(png(800, 500)), 'logo')).toThrow(/must be square/);
    expect(() => assertStoreImage(file(png(1200, 300)), 'cover')).toThrow(/at least 1600 x 400/);
    expect(() => assertStoreImage(file(png(1600, 800)), 'cover')).toThrow(/4:1/);
  });
  it('rules text matches the numbers shown to sellers', () => {
    expect(STORE_IMAGE_RULES.logo.hint).toBe('Square, at least 400 x 400, max 2 MB');
    expect(STORE_IMAGE_RULES.cover.hint).toBe('1600 x 400 (4:1), max 5 MB');
  });
});

describe('POST /api/upload/file with a store purpose', () => {
  const ctl = (upload = jest.fn().mockResolvedValue({ url: 'https://res.cloudinary.com/x.png' })) =>
    ({ c: new UploadController({ uploadFile: upload } as any, {} as any), upload });

  it('rejects a bad cover BEFORE it is stored (a bypassed web form cannot upload it)', async () => {
    const { c, upload } = ctl();
    await expect(c.uploadFile(file(png(1600, 400, 6 * 1024 * 1024)) as any, 'store_cover')).rejects.toBeInstanceOf(BadRequestException);
    expect(upload).not.toHaveBeenCalled();
  });
  it('accepts a good one, an unknown purpose is refused, no purpose = unchanged behaviour', async () => {
    const { c, upload } = ctl();
    await expect(c.uploadFile(file(png(600, 600)) as any, 'store_logo')).resolves.toMatchObject({ success: true });
    await expect(c.uploadFile(file(png(600, 600)) as any, 'whatever')).rejects.toThrow(/Unknown upload purpose/);
    await expect(c.uploadFile(file(png(10, 10)) as any)).resolves.toMatchObject({ success: true });
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
