/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { assertFileContent, assertRasterImage, looksLikeMarkup, sniffKind } from './file-signature.util';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a....');
const PDF = Buffer.from('%PDF-1.7\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('sniffKind', () => {
  it.each([
    ['jpeg', JPEG], ['png', PNG], ['webp', WEBP], ['gif', GIF], ['pdf', PDF], ['zip', ZIP],
    ['unknown', Buffer.from('hello world')], ['unknown', Buffer.alloc(0)],
  ])('detects %s', (kind, buf) => expect(sniffKind(buf)).toBe(kind));

  it('recognises HEIC/AVIF by the ftyp brand', () => {
    expect(sniffKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]))).toBe('heif');
    expect(sniffKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif')]))).toBe('heif');
    expect(sniffKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]))).toBe('unknown'); // mp4 is not an image
  });
});

describe('assertRasterImage (banners, onboarding slides)', () => {
  it('accepts real jpg/png/webp and returns the real MIME', () => {
    expect(assertRasterImage({ buffer: JPEG })).toBe('image/jpeg');
    expect(assertRasterImage({ buffer: PNG })).toBe('image/png');
    expect(assertRasterImage({ buffer: WEBP })).toBe('image/webp');
  });
  it.each([
    ['html disguised as an image', Buffer.from('<html><body>x</body></html>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['gif (not allowed for banners)', GIF],
    ['pdf', PDF],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_n, buf) => expect(() => assertRasterImage({ buffer: buf })).toThrow(/jpg, png or webp/));
});

describe('assertFileContent', () => {
  it('returns the sniffed MIME for a genuine image / PDF', () => {
    expect(assertFileContent({ originalname: 'a.JPG', buffer: JPEG })).toBe('image/jpeg');
    expect(assertFileContent({ originalname: 'a.pdf', buffer: PDF })).toBe('application/pdf');
  });
  it('rejects an extension that lies, in both directions', () => {
    expect(() => assertFileContent({ originalname: 'a.png', buffer: JPEG })).toThrow(/not a real \.png/);
    expect(() => assertFileContent({ originalname: 'a.pdf', buffer: Buffer.from('MZ....') })).toThrow(/not a real \.pdf/);
    expect(() => assertFileContent({ originalname: 'a.docx', buffer: PDF })).toThrow(/does not match/);
  });
  it('rejects markup behind a harmless extension unless markup is allowed (private .svg)', () => {
    const svg = Buffer.from('  <?xml version="1.0"?><svg></svg>');
    expect(looksLikeMarkup(svg)).toBe(true);
    expect(() => assertFileContent({ originalname: 'notes.txt', buffer: svg })).toThrow(/not allowed/);
    expect(assertFileContent({ originalname: 'logo.svg', buffer: svg }, { allowMarkup: true })).toBeNull();
  });
  it('lets ordinary documents through', () => {
    expect(assertFileContent({ originalname: 'deck.pptx', buffer: ZIP })).toBeNull();
    expect(assertFileContent({ originalname: 'readme.txt', buffer: Buffer.from('Lesson 1: fractions') })).toBeNull();
  });
});