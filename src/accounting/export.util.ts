/* eslint-disable prettier/prettier */
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

/** A report flattened for export (CSV / Excel / PDF). Numbers stay numbers so Excel can sum them. */
export interface ReportTable {
  title: string;
  subtitle: string;
  columns: { key: string; label: string; align?: 'left' | 'right'; width?: number }[];
  rows: Record<string, string | number | null | undefined>[];
  /** Rendered bold (section headers / totals) when the row carries `_bold: 1`. */
}

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Spreadsheet formula injection guard (=, +, -, @ at the start of a text cell). */
function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(t: ReportTable): Buffer {
  const esc = (v: string | number | null | undefined) => {
    if (v == null) return '';
    const s = isNum(v) ? String(v) : safeText(String(v));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [esc(t.title), esc(t.subtitle), '', t.columns.map((c) => esc(c.label)).join(',')];
  for (const r of t.rows) lines.push(t.columns.map((c) => esc(r[c.key])).join(','));
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string)
  // XML 1.0 forbids most control characters.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Minimal OOXML workbook (one sheet, bold header/total rows, 2-dp number format), zipped with archiver. */
export async function toXlsx(t: ReportTable): Promise<Buffer> {
  const cell = (ref: string, v: string | number | null | undefined, style: number) => {
    if (v == null || v === '') return `<c r="${ref}" s="${style}"/>`;
    if (isNum(v)) return `<c r="${ref}" s="${style === 1 ? 3 : 2}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEsc(safeText(String(v)))}</t></is></c>`;
  };
  const rows: string[] = [];
  let r = 1;
  rows.push(`<row r="${r}">${cell(`A${r}`, t.title, 1)}</row>`); r++;
  rows.push(`<row r="${r}">${cell(`A${r}`, t.subtitle, 0)}</row>`); r += 2;
  rows.push(`<row r="${r}">${t.columns.map((c, i) => cell(`${colName(i)}${r}`, c.label, 1)).join('')}</row>`); r++;
  for (const row of t.rows) {
    const bold = row._bold ? 1 : 0;
    rows.push(`<row r="${r}">${t.columns.map((c, i) => cell(`${colName(i)}${r}`, row[c.key], bold)).join('')}</row>`);
    r++;
  }
  const cols = t.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? (c.align === 'right' ? 16 : 28)}" customWidth="1"/>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>`;
  const sheetName = xmlEsc(t.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet,
    'xl/styles.xml': styles,
  };
  return new Promise<Buffer>((resolve, reject) => {
    const zip = archiver('zip', { zlib: { level: 9 } });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, body] of Object.entries(files)) zip.append(body, { name });
    void zip.finalize();
  });
}

/** WinAnsi-only text for the standard PDF fonts (anything else becomes '?'). */
const pdfText = (s: string) => s.replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/** Landscape A4 table PDF with repeated header row, right-aligned numbers and page numbers. */
export async function toPdf(t: ReportTable): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 842, H = 595, M = 36, size = 8.5, rowH = 14;
  const usable = W - M * 2;
  const weights = t.columns.map((c) => c.width ?? (c.align === 'right' ? 14 : 26));
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * usable);
  const fit = (s: string, w: number, f: typeof font) => {
    let out = pdfText(s);
    while (out.length > 1 && f.widthOfTextAtSize(out, size) > w - 4) out = out.slice(0, -1);
    return out;
  };
  let page = doc.addPage([W, H]);
  let y = H - M;
  const header = () => {
    let x = M;
    t.columns.forEach((c, i) => {
      const txt = fit(c.label, widths[i], bold);
      const tx = c.align === 'right' ? x + widths[i] - bold.widthOfTextAtSize(txt, size) - 2 : x + 2;
      page.drawText(txt, { x: tx, y, size, font: bold, color: rgb(0.2, 0.25, 0.3) });
      x += widths[i];
    });
    y -= 4;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.75, 0.78, 0.8) });
    y -= rowH - 4;
  };
  page.drawText(pdfText(t.title), { x: M, y, size: 15, font: bold, color: rgb(0.08, 0.18, 0.26) });
  y -= 16;
  page.drawText(pdfText(t.subtitle), { x: M, y, size: 9, font, color: rgb(0.35, 0.4, 0.45) });
  y -= 20;
  header();
  for (const row of t.rows) {
    if (y < M + rowH) { page = doc.addPage([W, H]); y = H - M; header(); }
    const f = row._bold ? bold : font;
    let x = M;
    t.columns.forEach((c, i) => {
      const v = row[c.key];
      const txt = v == null ? '' : fit(isNum(v) ? money(v) : String(v), widths[i], f);
      const tx = c.align === 'right' ? x + widths[i] - f.widthOfTextAtSize(txt, size) - 2 : x + 2;
      if (txt) page.drawText(txt, { x: tx, y, size, font: f, color: rgb(0.1, 0.12, 0.15) });
      x += widths[i];
    });
    y -= rowH;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}  ·  Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, { x: M, y: 18, size: 7.5, font, color: rgb(0.5, 0.5, 0.5) }));
  return Buffer.from(await doc.save());
}

export async function exportTable(t: ReportTable, format: ExportFormat): Promise<{ body: Buffer; contentType: string; ext: string }> {
  if (format === 'xlsx') return { body: await toXlsx(t), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  if (format === 'pdf') return { body: await toPdf(t), contentType: 'application/pdf', ext: 'pdf' };
  return { body: toCsv(t), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
}
