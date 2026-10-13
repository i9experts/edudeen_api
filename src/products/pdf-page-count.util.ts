import { PDFDocument } from 'pdf-lib';

/** Largest PDF we will download just to count its pages. Bigger files are skipped (pageCount stays unset). */
export const PDF_PAGE_COUNT_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_PAGE_COUNT_TIMEOUT_MS = 30_000;

/** Page count of a PDF buffer, or null when it can't be parsed (encrypted/corrupt/not a PDF). Never throws. */
export async function countPdfPages(bytes: Uint8Array | Buffer): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const n = doc.getPageCount();
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Downloads a PDF (size-capped, time-limited) and returns its page count; null on ANY failure. Never throws. */
export async function fetchPdfPageCount(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number | null> {
  const maxBytes = opts.maxBytes ?? PDF_PAGE_COUNT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? PDF_PAGE_COUNT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { ctrl.abort(); return null; }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = (res.body as any).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { ctrl.abort(); return null; }
      chunks.push(value);
    }
    return await countPdfPages(Buffer.concat(chunks));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const isPdfName = (name: unknown, mimeType?: unknown) =>
  mimeType === 'application/pdf' || (typeof name === 'string' && /\.pdf$/i.test(name));
