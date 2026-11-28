/* eslint-disable prettier/prettier */
/**
 * Courier COD statements: reading the file (CSV or Excel, no extra dependencies), finding the columns, matching
 * parcels to our shipments and building the remittance journal. Pure functions; the service does the database work.
 */
import { inflateRawSync } from 'node:zlib';
import { POSTING_ACCOUNTS as A } from '../accounting.constants';
import { round2 } from '../accounting.util';
import type { DraftLine } from '../posting/posting.rules';

// ── File reading ─────────────────────────────────────────────────────────────

/** RFC 4180 CSV (quotes, doubled quotes, CRLF/LF), with a leading BOM removed. Also accepts ; or tab separators. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((c) => [c, firstLine.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Entries of a .zip (an .xlsx is one): name -> uncompressed bytes. Stored and deflated entries only. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory: signature 0x06054b50, searched from the end (a comment may follow it).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found). Save it again as .xlsx or .csv.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx file.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');

/** Column letters (A, Z, AA) -> 0-based index. */
const colIndex = (ref: string) => { let n = 0; for (const c of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

/** First worksheet of an .xlsx as rows of text cells. */
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(xmlText((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  // The first sheet in workbook order, falling back to the lowest-numbered sheet file.
  let sheetPath: string | null = null;
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const firstRid = wb?.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  if (firstRid && rels) {
    const target = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`))?.[1]
      ?? rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstRid}"`))?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  if (!sheetPath || !files.has(sheetPath)) sheetPath = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0] ?? null;
  const sheet = sheetPath ? files.get(sheetPath)?.toString('utf8') : null;
  if (!sheet) throw new Error('The workbook has no worksheet.');
  const rows: string[][] = [];
  for (const r of sheet.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = [];
    for (const c of r.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/\br="([A-Z]+\d+)"/)?.[1];
      const t = c.match(/\bt="([^"]+)"/)?.[1];
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text = '';
      if (t === 's' && v != null) text = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') text = xmlText((c.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join(''));
      else if (v != null) text = xmlText(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = text;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
}

/** CSV or Excel by content (zip signature) rather than by trusting the file name. */
export function readStatement(buf: Buffer): string[][] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  return parseCsv(buf.toString('utf8'));
}

// ── Columns ──────────────────────────────────────────────────────────────────
export interface ColumnMapping { tracking: string; cod: string; charges?: string | null }

const GENERIC = {
  tracking: ['tracking number', 'tracking no', 'tracking #', 'tracking', 'cn number', 'cn no', 'cn #', 'cn', 'consignment number', 'consignment no', 'booked packet cn', 'awb', 'awb number'],
  cod: ['cod amount', 'cod collected', 'collected amount', 'amount collected', 'collect amount', 'booked packet collect amount', 'invoice payment', 'cod', 'amount'],
  charges: ['total charges', 'delivery charges', 'shipping charges', 'courier charges', 'shipment charges', 'cod charges', 'service charges', 'transaction fee', 'charges', 'deduction', 'deductions', 'fee'],
};
/** Courier-specific header names tried before the generic ones. Editable per upload in the UI. */
export const COURIER_PRESETS: Record<string, { tracking: string[]; cod: string[]; charges: string[] }> = {
  tcs: { tracking: ['cn #', 'cn no', 'consignment no', 'consignment number'], cod: ['cod amount', 'collected amount'], charges: ['delivery charges', 'charges'] },
  leopards: { tracking: ['cn number', 'booked packet cn', 'cn #'], cod: ['booked packet collect amount', 'collect amount', 'cod amount'], charges: ['shipment charges', 'delivery charges', 'charges'] },
  postex: { tracking: ['tracking number', 'tracking no'], cod: ['invoice payment', 'cod amount'], charges: ['transaction fee', 'delivery charges', 'charges'] },
  other: { tracking: [], cod: [], charges: [] },
};

const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[_\s]+/g, ' ').replace(/[.:]/g, '').trim();

/** Finds the header row (within the first 15) and the tracking / COD / charges columns. */
export function detectColumns(rows: string[][], courier: string, override?: Partial<ColumnMapping> | null): { headerRow: number; headers: string[]; mapping: ColumnMapping | null } {
  const preset = COURIER_PRESETS[courier] ?? COURIER_PRESETS.other;
  const pick = (headers: string[], wanted: (string | null | undefined)[]) => {
    const h = headers.map(norm);
    for (const w of wanted) { if (!w) continue; const i = h.indexOf(norm(w)); if (i >= 0) return headers[i]; }
    return null;
  };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const headers = rows[i].map((c) => String(c ?? '').trim());
    const tracking = pick(headers, [override?.tracking, ...preset.tracking, ...GENERIC.tracking]);
    const cod = pick(headers, [override?.cod, ...preset.cod, ...GENERIC.cod]);
    if (tracking && cod && tracking !== cod) {
      const charges = pick(headers, [override?.charges, ...preset.charges, ...GENERIC.charges]);
      return { headerRow: i, headers, mapping: { tracking, cod, charges: charges && charges !== cod && charges !== tracking ? charges : null } };
    }
  }
  return { headerRow: 0, headers: (rows[0] ?? []).map((c) => String(c ?? '').trim()), mapping: null };
}

/** "Rs. 1,250.00", "(150)", "PKR 1 250", "-75" -> number (brackets or a minus = negative). */
export function parseAmount(v: unknown): number {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  // The first number in the cell, with thousands separators (comma or space) allowed; "Rs." prefixes are ignored.
  const m = s.match(/-?\d[\d,\s]*(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(m[0].replace(/[,\s]/g, ''));
  const neg = /^\(.*\)$/.test(s) || m[0].startsWith('-');
  return Number.isFinite(n) ? round2(neg ? -Math.abs(n) : Math.abs(n)) : 0;
}

/** Tracking numbers compared without spaces, quotes or case. */
export const normalizeTracking = (s: unknown) => String(s ?? '').replace(/[\s'"`]/g, '').toUpperCase();

export interface StatementLine { trackingNumber: string; codCollected: number; charges: number }

export function extractLines(rows: string[][], headerRow: number, headers: string[], mapping: ColumnMapping): StatementLine[] {
  const ti = headers.indexOf(mapping.tracking);
  const ci = headers.indexOf(mapping.cod);
  const fi = mapping.charges ? headers.indexOf(mapping.charges) : -1;
  if (ti < 0 || ci < 0) throw new Error('The chosen columns are not in the file.');
  const out: StatementLine[] = [];
  for (const r of rows.slice(headerRow + 1)) {
    const trackingNumber = normalizeTracking(r[ti]);
    if (!trackingNumber || /^total/i.test(trackingNumber)) continue;
    out.push({ trackingNumber, codCollected: parseAmount(r[ci]), charges: fi >= 0 ? Math.abs(parseAmount(r[fi])) : 0 });
  }
  return out;
}

// ── Matching ─────────────────────────────────────────────────────────────────
export interface ParcelInfo {
  orderId: string;
  orderNumber: string | null;
  sellerOrderId: string;
  storeId: string | null;
  customerId: string | null;
  customerName: string | null;
  /** PKR. */
  codExpected: number;
}
export type MatchStatus = 'matched' | 'short' | 'over' | 'unknown' | 'duplicate';
export interface MatchedLine extends StatementLine {
  orderId: string | null; orderNumber: string | null; sellerOrderId: string | null; storeId: string | null; customerId: string | null; customerName: string | null;
  codExpected: number | null; status: MatchStatus; note: string | null; duplicateOf: string | null;
}

/** Rupee tolerance before a parcel counts as short/over (rounding on courier statements). */
export const COD_TOLERANCE = 1;

export function matchLines(lines: StatementLine[], parcels: Map<string, ParcelInfo>, remitted: Map<string, string>, selfId?: string | null): MatchedLine[] {
  const seen = new Set<string>();
  return lines.map((l) => {
    const p = parcels.get(l.trackingNumber) ?? null;
    const base: MatchedLine = {
      ...l, orderId: p?.orderId ?? null, orderNumber: p?.orderNumber ?? null, sellerOrderId: p?.sellerOrderId ?? null, storeId: p?.storeId ?? null,
      customerId: p?.customerId ?? null, customerName: p?.customerName ?? null, codExpected: p ? round2(p.codExpected) : null, status: 'matched', note: null, duplicateOf: null,
    };
    const other = remitted.get(l.trackingNumber);
    if (other && other !== selfId) return { ...base, status: 'duplicate', duplicateOf: other, note: 'Already remitted in another approved statement' };
    if (seen.has(l.trackingNumber)) return { ...base, status: 'duplicate', note: 'Listed twice in this statement' };
    seen.add(l.trackingNumber);
    if (!p) return { ...base, status: 'unknown', note: 'No Edudeen shipment with this tracking number' };
    const diff = round2(l.codCollected - p.codExpected);
    if (diff < -COD_TOLERANCE) return { ...base, status: 'short', note: `Collected ${Math.abs(diff)} less than booked` };
    if (diff > COD_TOLERANCE) return { ...base, status: 'over', note: `Collected ${diff} more than booked` };
    return base;
  });
}

export function remittanceTotals(lines: { codCollected: number; charges: number; status: string }[], otherDeductions: number, netReceived: number) {
  const counted = lines.filter((l) => l.status !== 'duplicate');
  const gross = round2(counted.reduce((s, l) => s + (Number(l.codCollected) || 0), 0));
  const charges = round2(counted.reduce((s, l) => s + (Number(l.charges) || 0), 0));
  const expectedNet = round2(gross - charges - (Number(otherDeductions) || 0));
  return { gross, charges, expectedNet, difference: round2((Number(netReceived) || 0) - expectedNet) };
}

/**
 * Remittance journal (PKR): Dr bank (net), Dr courier charges, Dr other deductions / Cr COD receivable per parcel
 * (customer party, so each buyer's ledger shows their parcel cleared), unknown parcels and any bank difference to
 * suspense. Duplicate lines are never posted (approval is blocked while any remain).
 */
export function remittanceJournalLines(rem: {
  courier: string; statementRef?: string | null; bankAccount: string; otherDeductions: number; netReceived: number; otherDeductionsAccount?: string | null;
  lines: { trackingNumber: string; codCollected: number; charges: number; status: string; customerId?: string | null; customerName?: string | null; storeId?: string | null; orderNumber?: string | null }[];
}): DraftLine[] {
  const t = remittanceTotals(rem.lines, rem.otherDeductions, rem.netReceived);
  const out: DraftLine[] = [];
  if (rem.netReceived > 0) out.push({ accountCode: rem.bankAccount, debit: round2(rem.netReceived), description: `${rem.courier.toUpperCase()} COD remittance${rem.statementRef ? ` ${rem.statementRef}` : ''}` });
  if (t.charges > 0) out.push({ accountCode: A.courierExpense, debit: t.charges, description: 'Courier delivery / COD charges deducted' });
  if (rem.otherDeductions > 0) out.push({ accountCode: rem.otherDeductionsAccount || '6900', debit: round2(rem.otherDeductions), description: 'Other deductions on the statement' });
  if (t.difference < 0) out.push({ accountCode: A.suspense, debit: Math.abs(t.difference), description: 'Bank received less than the statement adds up to' });
  for (const l of rem.lines) {
    if (l.status === 'duplicate' || !(l.codCollected > 0)) continue;
    if (l.status === 'unknown') out.push({ accountCode: A.suspense, credit: round2(l.codCollected), description: `Unknown parcel ${l.trackingNumber}` });
    else out.push({
      accountCode: A.codReceivable, credit: round2(l.codCollected), storeId: l.storeId ?? null,
      party: l.customerId ? { type: 'customer', id: l.customerId, name: l.customerName ?? null } : null,
      description: `Parcel ${l.trackingNumber}${l.orderNumber ? ` (order #${l.orderNumber})` : ''}`,
    });
  }
  // Negative COD lines (courier reversals) reduce what is cleared.
  for (const l of rem.lines) {
    if (l.status === 'duplicate' || !(l.codCollected < 0)) continue;
    out.push({ accountCode: l.status === 'unknown' ? A.suspense : A.codReceivable, debit: round2(Math.abs(l.codCollected)), description: `Reversal ${l.trackingNumber}` });
  }
  if (t.difference > 0) out.push({ accountCode: A.suspense, credit: t.difference, description: 'Bank received more than the statement adds up to' });
  return out;
}

// ── Outstanding COD aging ────────────────────────────────────────────────────
export const AGING_BUCKETS = ['0-7', '8-15', '16-30', '30+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(deliveredAt: Date, now = new Date()): { days: number; bucket: AgingBucket } {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(deliveredAt).getTime()) / 86_400_000));
  return { days, bucket: days <= 7 ? '0-7' : days <= 15 ? '8-15' : days <= 30 ? '16-30' : '30+' };
}

/** What the rider collects for a package (same rule the courier booking uses). */
export function packageCodAmount(order: { totalAmount?: number; sellerOrders?: unknown[] }, so: { codAmount?: number; subtotal?: number }): number {
  const single = (order.sellerOrders?.length ?? 1) === 1;
  return round2(single ? Number(order.totalAmount ?? 0) : Number(so.codAmount) > 0 ? Number(so.codAmount) : Number(so.subtotal ?? 0));
}
