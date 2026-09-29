/* eslint-disable prettier/prettier */
import { Writable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';
import { UploadService } from './upload.service';

const file = (originalname: string, mimetype: string) =>
  ({ originalname, mimetype, buffer: Buffer.from('x'), size: 1 }) as Express.Multer.File;

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
    for (const [n, m] of [
      ['lesson.pdf', 'application/pdf'],
      ['bundle.zip', 'application/zip'],
      ['book.epub', 'application/epub+zip'],
      ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ]) {
      await expect(service.uploadPrivateFile(file(n, m))).resolves.toMatchObject({ publicId: 'pid' });
    }
    await expect(service.uploadFile(file('cover.jpg', 'image/jpeg'))).resolves.toMatchObject({ publicId: 'pid' });
    jest.restoreAllMocks();
  });
});
