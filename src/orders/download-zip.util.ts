import archiver from 'archiver';
import { Readable } from 'node:stream';

/** Caps for "download all as zip". Sizes come from our own upload records (file.size). */
export const ZIP_MAX_FILE_BYTES = 500 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/** One safe file name inside the zip: no directories, no traversal, no control chars, no reserved Windows chars. */
export function safeZipEntryName(raw: unknown, fallback = 'file'): string {
  let n = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!n || /^\.+$/.test(n)) n = fallback;
  return n.length > 150 ? n.slice(0, 150) : n;
}

/** Unique, safe names for a list of file names; duplicates become "name (2).ext" (case-insensitive). */
export function uniqueZipEntryNames(names: unknown[]): string[] {
  const seen = new Set<string>();
  return names.map((raw, i) => {
    const base = safeZipEntryName(raw, `file-${i + 1}`);
    let name = base;
    for (let k = 2; seen.has(name.toLowerCase()); k++) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)} (${k})${base.slice(dot)}` : `${base} (${k})`;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

/** Safe `<product>.zip` file name for Content-Disposition. */
export function zipDownloadName(productName: unknown): string {
  const base = safeZipEntryName(productName, 'download').replace(/\.zip$/i, '');
  return `${base}.zip`;
}

export interface ZipSource {
  name: string;
  /** Opened lazily, one file at a time, so only one source is in flight. */
  open: () => Promise<Readable | Buffer>;
}

/** Streams the sources into a zip (stored, not deflated: PDFs/videos/images are already compressed). The returned
 *  archive is piped by the caller; an error opening any source aborts the archive, so the client sees a failed download. */
export function buildZipStream(sources: ZipSource[]): archiver.Archiver {
  const archive = archiver('zip', { store: true });
  (async () => {
    for (const s of sources) {
      const body = await s.open();
      archive.append(body as any, { name: s.name });
      // wait until this entry has been consumed before opening the next (bounded memory / connections)
      await new Promise<void>((resolve, reject) => {
        const onEntry = (e: { name: string }) => { if (e.name === s.name) { cleanup(); resolve(); } };
        const onErr = (err: Error) => { cleanup(); reject(err); };
        const cleanup = () => { archive.off('entry', onEntry); archive.off('error', onErr); };
        archive.on('entry', onEntry);
        archive.on('error', onErr);
      });
    }
    await archive.finalize();
  })().catch((err) => archive.destroy(err));
  return archive;
}
