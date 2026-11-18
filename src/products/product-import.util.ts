/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { assertPriceRules, assertDescriptionRule, assertStockRule, cleanShippingWeight } from './price-rules.util';
import { assertText, cleanLearningMeta } from './product-input.util';
import { assertTitleRule, normalizeTitle } from './product-quality.util';
import { cleanSku } from './sku.util';
import { toCsv } from '../analytics/utils/csv.util';

/**
 * CSV product import (drafts only). Pure helpers: parsing, formula defusing and per-row validation.
 * Validation reuses the SAME functions the single-product create uses (title, description, price, stock, weight,
 * class range, sku), and the commit step goes through the real create methods again, so the two cannot drift.
 */
export const IMPORT_MAX_ROWS = 200;
export const IMPORT_MAX_BYTES = 1_000_000;
const MAX_PRICE = 1_000_000;

export type ImportType = 'physical' | 'digital';

const COMMON = ['title', 'description', 'price', 'compare_at_price', 'class_from', 'class_to', 'tags'] as const;
export const IMPORT_COLUMNS: Record<ImportType, { all: readonly string[]; required: readonly string[] }> = {
  physical: { all: [...COMMON, 'stock', 'unlimited_stock', 'shipping_weight', 'sku'], required: ['title', 'description', 'price', 'shipping_weight'] },
  digital: { all: [...COMMON], required: ['title', 'description', 'price'] },
};

const EXAMPLE: Record<ImportType, string[]> = {
  physical: ['Wooden abacus counting frame for kids', 'A sturdy wooden counting frame that helps children learn numbers and simple sums.', '1500', '1800', '1', '3', 'maths|abacus', '20', 'no', '600 g', ''],
  digital: ['Class 5 science worksheets pack', 'Twenty printable worksheets covering the class 5 science syllabus with an answer key.', '500', '', '5', '5', 'science|worksheets'],
};

export function isImportType(v: unknown): v is ImportType {
  return v === 'physical' || v === 'digital';
}

/** The downloadable template: header row + one example row. */
export function importTemplateCsv(type: ImportType): string {
  return toCsv([...IMPORT_COLUMNS[type].all], [EXAMPLE[type]]);
}

/** RFC 4180 style parser: quotes, "" escapes, CRLF/LF, newlines inside quotes, BOM; `,` or `;` (Excel in some locales). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (inQuotes) throw new BadRequestException('The file has an opening quote that is never closed. Check the quotes and upload again.');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Spreadsheet formulas: a text cell may not START with = + - @ (or a tab / CR). The leading characters are removed. */
export function defuseCell(raw: string): { value: string; changed: boolean } {
  const trimmed = String(raw ?? '').trim();
  const value = trimmed.replace(/^[=+\-@\t\r\s]+/, '');
  return { value, changed: value !== trimmed && /^[=+\-@\t\r]/.test(trimmed) };
}

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s\-]+/g, '_');

export interface ImportRowResult {
  /** 1-based spreadsheet row number (the header is row 1, so the first product is row 2). */
  row: number;
  title: string;
  ok: boolean;
  errors: { field: string; message: string }[];
  warnings: string[];
  /** Body for the real create method (only when ok). */
  body: Record<string, unknown> | null;
  /** The cleaned cells, so errors.csv can return the row. */
  cells: Record<string, string>;
}

export interface ParsedImport {
  type: ImportType;
  columns: string[];
  ignoredColumns: string[];
  rows: ImportRowResult[];
}

/** 5, Class 5, O Level -> the stored class value (class-5, o-level); anything else is left for the real validator to refuse. */
export function normClass(v: string | undefined): string {
  const t = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (/^\d{1,2}$/.test(t)) return `class-${t}`;
  return t.replace(/^class(\d+)$/, 'class-$1');
}

const yes = (v: string) => /^(1|y|yes|true)$/i.test(v.trim());
const no = (v: string) => v.trim() === '' || /^(0|n|no|false)$/i.test(v.trim());

function money(v: string, field: string, errors: { field: string; message: string }[], required: boolean): number | undefined {
  const t = v.trim();
  if (!t) { if (required) errors.push({ field, message: `${field} is required` }); return undefined; }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) { errors.push({ field, message: `${field} must be a plain number such as 1500 or 1500.50 (no currency sign or commas)` }); return undefined; }
  const n = Number(t);
  if (n > MAX_PRICE) { errors.push({ field, message: `${field} must be between 0 and ${MAX_PRICE}` }); return undefined; }
  return n;
}

/** Validate one row exactly like the single-product form does. Never throws. */
export function validateImportRow(type: ImportType, cells: Record<string, string>, currency: string | null | undefined, rowNo: number): ImportRowResult {
  const errors: { field: string; message: string }[] = [];
  const warnings: string[] = [];
  const guard = (field: string, fn: () => void) => { try { fn(); } catch (e: any) { errors.push({ field, message: String(e?.message ?? 'Invalid value') }); } };

  // Text cells: formulas are defused first.
  const clean: Record<string, string> = { ...cells };
  for (const f of ['title', 'description', 'tags', 'sku', 'class_from', 'class_to']) {
    if (clean[f] === undefined) continue;
    const d = defuseCell(clean[f]);
    if (d.changed) warnings.push(`${f}: a leading "=", "+", "-" or "@" was removed (spreadsheet formulas are not allowed)`);
    clean[f] = d.value;
  }

  let title = '';
  guard('title', () => {
    if (!clean.title) throw new BadRequestException('title is required');
    assertText(clean.title, 'title', 200);
    title = normalizeTitle(clean.title);
    assertTitleRule(title);
  });
  guard('description', () => { assertDescriptionRule(clean.description); assertText(clean.description, 'description', 20000); });

  const price = money(clean.price ?? '', 'price', errors, true);
  const compareAt = money(clean.compare_at_price ?? '', 'compare_at_price', errors, false);
  if (price !== undefined) guard('price', () => assertPriceRules({ price, compareAtPrice: compareAt, currency, priceLabel: 'Price' }));

  const body: Record<string, unknown> = { name: title || clean.title, description: clean.description, status: 'draft' };
  const tags = (clean.tags ?? '').split(/[|;]/).map((t) => t.trim()).filter(Boolean);
  if (tags.length > 30) errors.push({ field: 'tags', message: 'At most 30 tags' });
  if (tags.length) body.tags = tags;
  if (clean.class_from || clean.class_to) {
    const classFrom = normClass(clean.class_from); const classTo = normClass(clean.class_to);
    guard('class_from', () => { cleanLearningMeta({ classFrom: classFrom || null, classTo: classTo || null }); });
    body.classFrom = classFrom || null; body.classTo = classTo || null;
  }

  if (type === 'physical') {
    const unlimited = yes(clean.unlimited_stock ?? '');
    if (!unlimited && !no(clean.unlimited_stock ?? '')) errors.push({ field: 'unlimited_stock', message: 'unlimited_stock must be yes or no' });
    let stock: number | undefined;
    const st = (clean.stock ?? '').trim();
    if (st !== '') {
      if (!/^\d+$/.test(st)) errors.push({ field: 'stock', message: 'Stock must be a whole number' });
      else stock = Number(st);
    }
    guard('stock', () => assertStockRule(stock, unlimited));
    let weight: string | undefined;
    guard('shipping_weight', () => { weight = cleanShippingWeight(clean.shipping_weight, true); });
    let sku: string | undefined;
    guard('sku', () => { sku = cleanSku(clean.sku); });
    body.variants = [{
      price, ...(compareAt !== undefined ? { compareAtPrice: compareAt } : {}),
      ...(stock !== undefined ? { stock } : {}), unlimitedStock: unlimited, shippingWeight: weight ?? clean.shipping_weight, options: [], ...(sku ? { sku } : {}),
    }];
  } else {
    body.price = price;
    if (compareAt !== undefined) body.compareAtPrice = compareAt;
  }

  const ok = errors.length === 0;
  return { row: rowNo, title: title || clean.title || '', ok, errors, warnings, body: ok ? body : null, cells: clean };
}

/** Parse + validate a whole file. Throws a readable 400 for file-level problems (size, headers, row limit). */
export function parseImportFile(buffer: Buffer, type: ImportType, currency: string | null | undefined): ParsedImport {
  if (!buffer?.length) throw new BadRequestException('The file is empty.');
  if (buffer.length > IMPORT_MAX_BYTES) throw new BadRequestException('The file is too large (limit 1 MB).');
  // Binary content (xlsx / zip / pdf) is not a CSV: NUL bytes or the ZIP / PDF magic.
  if (buffer.includes(0) || buffer.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004' || buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    throw new BadRequestException('This does not look like a CSV file. In Excel use Save As > CSV (UTF-8), then upload that file.');
  }
  const table = parseCsv(buffer.toString('utf8'));
  if (table.length < 2) throw new BadRequestException('The file needs a header row and at least one product row.');
  if (table.length - 1 > IMPORT_MAX_ROWS) throw new BadRequestException(`Too many rows: ${table.length - 1}. The limit is ${IMPORT_MAX_ROWS} products per file.`);

  const spec = IMPORT_COLUMNS[type];
  const headers = table[0].map(normHeader);
  const missing = spec.required.filter((c) => !headers.includes(c));
  if (missing.length) throw new BadRequestException(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Download the template to see the expected headers.`);
  const ignoredColumns = headers.filter((h) => h && !spec.all.includes(h));

  const rows = table.slice(1).map((r, i) => {
    const cells: Record<string, string> = {};
    headers.forEach((h, idx) => { if (spec.all.includes(h)) cells[h] = (r[idx] ?? '').toString(); });
    return validateImportRow(type, cells, currency, i + 2);
  });

  // Same title + price twice in the file: warn (the second one is probably a copy-paste).
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.ok) continue;
    const key = `${r.title.toLowerCase()}|${r.cells.price}`;
    const first = seen.get(key);
    if (first) r.warnings.push(`Same title and price as row ${first}`); else seen.set(key, r.row);
  }
  return { type, columns: headers, ignoredColumns, rows };
}

/** errors.csv: the failed rows (original cells + the reason) so they can be fixed and uploaded again. */
export function importErrorsCsv(type: ImportType, rows: { row: number; cells: Record<string, string>; message: string }[]): string {
  const cols = [...IMPORT_COLUMNS[type].all];
  return toCsv(['row', ...cols, 'error'], rows.map((r) => [r.row, ...cols.map((c) => r.cells[c] ?? ''), r.message]));
}
