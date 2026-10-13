import { Readable } from 'node:stream';
import { buildZipStream, safeZipEntryName, uniqueZipEntryNames, zipDownloadName } from './download-zip.util';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as any));
  return Buffer.concat(chunks);
}

describe('download zip util', () => {
  it('strips paths, traversal and control characters', () => {
    expect(safeZipEntryName('../../etc/passwd')).toBe('passwd');
    expect(safeZipEntryName('C:\\Users\\x\\a.pdf')).toBe('a.pdf');
    expect(safeZipEntryName('..')).toBe('file');
    expect(safeZipEntryName('a\r\nb"c.pdf')).toBe('a__b_c.pdf');
    expect(safeZipEntryName('')).toBe('file');
  });

  it('makes names unique case-insensitively', () => {
    expect(uniqueZipEntryNames(['a.pdf', 'A.pdf', 'a.pdf', 'b'])).toEqual(['a.pdf', 'A (2).pdf', 'a (3).pdf', 'b']);
  });

  it('builds a safe zip name', () => {
    expect(zipDownloadName('Grade 5 / Maths: "Pack"')).toBe('Maths_ _Pack_.zip');
    expect(zipDownloadName(null)).toBe('download.zip');
  });

  it('streams a zip with the entries (PK header, names present)', async () => {
    const archive = buildZipStream([
      { name: 'one.txt', open: async () => Readable.from([Buffer.from('hello')]) },
      { name: 'two.txt', open: async () => Buffer.from('world') },
    ]);
    const out = await collect(archive);
    expect(out.subarray(0, 2).toString()).toBe('PK');
    expect(out.includes(Buffer.from('one.txt'))).toBe(true);
    expect(out.includes(Buffer.from('two.txt'))).toBe(true);
    expect(out.includes(Buffer.from('hello'))).toBe(true);
    expect(out.includes(Buffer.from('world'))).toBe(true);
  });

  it('aborts the stream when a source fails to open', async () => {
    const archive = buildZipStream([{ name: 'x.txt', open: async () => { throw new Error('storage down'); } }]);
    await expect(collect(archive)).rejects.toThrow('storage down');
  });
});
