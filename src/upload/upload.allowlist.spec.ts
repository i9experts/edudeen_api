/* eslint-disable prettier/prettier */
import { Writable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';
import { UploadService } from './upload.service';

const file = (originalname: string, mimetype: string, buffer: Buffer = Buffer.from('x')) =>
  ({ originalname, mimetype, buffer, size: buffer.length }) as Express.Multer.File;

// Real first bytes, since uploads are judged by content and not by the declared type.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);

describe('UploadService — file type allowlist', () => {
  const service = new UploadService({ get: () => undefined } as any);

  it.each([
    ['avatar.svg', 'image/svg+xml'],
    ['page.html', 'text/html'],
    ['script.js', 'application/javascript'],
    ['tool.exe', 'application/x-msdownload'],
    ['evil.png', 'text/html'], // allowed extension, disguised MIME
    ['evil.svg', 'image/png'], // disguised extension
    ['noext', 'image/png'],
  ])('rejects public upload %s (%s)', async (name, mime) => {
    await expect(service.uploadFile(file(name, mime))).rejects.toThrow(/not allowed/);
  });

  it.each([
    ['page.html', 'text/html'],
    ['setup.exe', 'application/x-msdownload'],
    ['x.js', 'text/javascript'],
  ])('rejects private upload %s', async (name, mime) => {
    await expect(service.uploadPrivateFile(file(name, mime))).rejects.toThrow(/not allowed/);
  });

  it('accepts common education formats', async () => {
    jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((_opts: any, cb: any) => {
      return new Writable({
        write(_c, _e, done) { done(); },
        final(done) { cb(null, { public_id: 'pid', secure_url: 'https://x', width: 1, height: 1 }); done(); },
      });
    }) as any);
    for (const [n, m, b] of [
      ['lesson.pdf', 'application/pdf', PDF],
      ['bundle.zip', 'application/zip', ZIP],
      ['book.epub', 'application/epub+zip', ZIP],
      ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP],
    ] as [string, string, Buffer][]) {
      await expect(service.uploadPrivateFile(file(n, m, b))).resolves.toMatchObject({ publicId: 'pid' });
    }
    await expect(service.uploadFile(file('cover.jpg', 'image/jpeg', JPEG))).resolves.toMatchObject({ publicId: 'pid' });
    jest.restoreAllMocks();
  });

  describe('content checks (magic bytes)', () => {
    it.each([
      ['photo.jpg', 'image/jpeg', Buffer.from('<html><script>alert(1)</script></html>')],
      ['photo.png', 'image/png', JPEG], // jpeg bytes under a .png name
      ['doc.pdf', 'application/pdf', Buffer.from('MZ\\x90\\x00exe')],
      ['note.txt', 'text/plain', Buffer.from('<svg xmlns=\"http://www.w3.org/2000/svg\"><script>1</script></svg>')],
      ['renamed.docx', 'application/octet-stream', PDF], // a PDF pretending to be a document
    ])('rejects public upload %s whose bytes do not match', async (name, mime, buf) => {
      await expect(service.uploadFile(file(name, mime as string, buf as Buffer))).rejects.toThrow(/not a real|does not match|not allowed/);
    });

    it('ignores the declared MIME for a real image: Cloudinary resource type follows the sniffed type', async () => {
      const spy = jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((_o: any, cb: any) => new Writable({
        write(_c, _e, done) { done(); },
        final(done) { cb(null, { public_id: 'p', secure_url: 'https://x', width: 1, height: 1 }); done(); },
      })) as any);
      const f = file('a.jpg', 'application/octet-stream', JPEG);
      await service.uploadFile(f);
      expect(f.mimetype).toBe('image/jpeg');
      expect(spy.mock.calls[0][0]).toMatchObject({ resource_type: 'image' });
      jest.restoreAllMocks();
    });
  });
});
