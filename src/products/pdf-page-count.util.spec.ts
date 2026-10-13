import { PDFDocument } from 'pdf-lib';
import { countPdfPages, fetchPdfPageCount, isPdfName } from './pdf-page-count.util';

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return doc.save();
}

const resp = (body: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(body as any, { status: 200, headers });

describe('pdf page count util', () => {
  it('counts pages of a generated PDF', async () => {
    expect(await countPdfPages(await makePdf(7))).toBe(7);
  });

  it('returns null for garbage', async () => {
    expect(await countPdfPages(Buffer.from('not a pdf'))).toBeNull();
  });

  it('fetchPdfPageCount reads the body and counts', async () => {
    const pdf = await makePdf(3);
    const f = jest.fn().mockResolvedValue(resp(pdf));
    expect(await fetchPdfPageCount('https://x/y.pdf', { fetchImpl: f as any })).toBe(3);
  });

  it('skips files over the size cap and never throws', async () => {
    const pdf = await makePdf(2);
    const f = jest.fn().mockResolvedValue(resp(pdf));
    expect(await fetchPdfPageCount('https://x/y.pdf', { fetchImpl: f as any, maxBytes: 10 })).toBeNull();
    const boom = jest.fn().mockRejectedValue(new Error('network'));
    expect(await fetchPdfPageCount('https://x/y.pdf', { fetchImpl: boom as any })).toBeNull();
  });

  it('detects pdf by name or mime', () => {
    expect(isPdfName('A.PDF')).toBe(true);
    expect(isPdfName('a.docx', 'application/pdf')).toBe(true);
    expect(isPdfName('a.docx')).toBe(false);
  });
});
