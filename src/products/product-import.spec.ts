/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ProductImportService } from './product-import.service';
import { IMPORT_MAX_ROWS, defuseCell, importErrorsCsv, importTemplateCsv, parseCsv, parseImportFile, validateImportRow } from './product-import.util';

const HEAD = 'title,description,price,compare_at_price,stock,unlimited_stock,shipping_weight,class_from,class_to,tags,sku';
const GOOD = 'Wooden abacus counting frame for kids,A sturdy wooden counting frame that helps children learn numbers,1500,1800,20,no,600 g,1,3,maths|abacus,';
const buf = (...lines: string[]) => Buffer.from(lines.join('\n'), 'utf8');

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes, CRLF and a BOM', () => {
    const t = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nline2"\r\nlast,end');
    expect(t).toEqual([['a', 'b'], ['x, y', 'say "hi"\nline2'], ['last', 'end']]);
  });
  it('accepts a semicolon file (Excel in some regions) and skips blank lines', () => {
    expect(parseCsv('a;b\n\n1;2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('an unclosed quote is a readable 400, not a silent merge of every row', () => {
    expect(() => parseCsv('a,b\n"oops,1\n')).toThrow(BadRequestException);
  });
});

describe('formula defusing', () => {
  it('removes leading = + - @ from text cells', () => {
    expect(defuseCell('=HYPERLINK("http://x")')).toEqual({ value: 'HYPERLINK("http://x")', changed: true });
    expect(defuseCell('  @SUM(1)').changed).toBe(true);
    expect(defuseCell('+1 555')).toEqual({ value: '1 555', changed: true });
    expect(defuseCell('Normal title')).toEqual({ value: 'Normal title', changed: false });
  });
  it('a formula in the title is cleaned and reported as a warning on that row', () => {
    const r = validateImportRow('physical', { title: '=Wooden abacus counting frame', description: 'A sturdy wooden counting frame for children', price: '1500', shipping_weight: '600 g' }, 'PKR', 2);
    expect(r.ok).toBe(true);
    expect(r.body?.name).not.toMatch(/^[=+\-@]/);
    expect(r.warnings.join(' ')).toMatch(/formula/);
  });
  it('errors.csv defuses formulas again on the way out', () => {
    const csv = importErrorsCsv('digital', [{ row: 3, cells: { title: '=BAD()' }, message: 'x' }]);
    expect(csv).toContain(`"'=BAD()"`);
  });
});

describe('validateImportRow (same rules as the single-product form)', () => {
  const base = { title: 'Wooden abacus counting frame', description: 'A sturdy wooden counting frame for children', price: '1500', shipping_weight: '600 g', stock: '5', unlimited_stock: 'no' };
  it('a good physical row builds a DRAFT body with one variant', () => {
    const r = validateImportRow('physical', { ...base, compare_at_price: '1800', class_from: '1', class_to: '3', tags: 'a|b' }, 'PKR', 2);
    expect(r.ok).toBe(true);
    expect(r.body?.status).toBe('draft');
    expect((r.body?.variants as any[])[0]).toMatchObject({ price: 1500, compareAtPrice: 1800, stock: 5, shippingWeight: '0.6 kg' });
    expect(r.body?.tags).toEqual(['a', 'b']);
  });
  it('title too short, missing description, bad price and missing weight all report their own field', () => {
    const r = validateImportRow('physical', { title: 'Abacus', description: '', price: 'Rs 1,500', shipping_weight: '' }, 'PKR', 5);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field).sort()).toEqual(['description', 'price', 'shipping_weight', 'title']);
    expect(r.row).toBe(5);
  });
  it('compare-at must be above the price; PKR decimals are refused', () => {
    expect(validateImportRow('physical', { ...base, compare_at_price: '1000' }, 'PKR', 2).errors.some((e) => e.field === 'price')).toBe(true);
    expect(validateImportRow('physical', { ...base, price: '1500.50' }, 'PKR', 2).ok).toBe(false);
    expect(validateImportRow('physical', { ...base, price: '1500.50' }, 'USD', 2).ok).toBe(true);
  });
  it('stock must be a whole number; unlimited_stock must be yes/no; weight over 50 kg is refused', () => {
    expect(validateImportRow('physical', { ...base, stock: '2.5' }, 'PKR', 2).errors[0].field).toBe('stock');
    expect(validateImportRow('physical', { ...base, unlimited_stock: 'maybe' }, 'PKR', 2).errors[0].field).toBe('unlimited_stock');
    expect(validateImportRow('physical', { ...base, shipping_weight: '60 kg' }, 'PKR', 2).ok).toBe(false);
    expect(validateImportRow('physical', { ...base, stock: '', unlimited_stock: 'yes' }, 'PKR', 2).ok).toBe(true);
  });
  it('digital rows need no stock / weight and carry price directly', () => {
    const r = validateImportRow('digital', { title: 'Class 5 science worksheets pack', description: 'Twenty printable worksheets with an answer key', price: '500' }, 'PKR', 2);
    expect(r.ok).toBe(true);
    expect(r.body).toMatchObject({ price: 500, status: 'draft' });
  });
});

describe('parseImportFile', () => {
  it('file-level problems are readable 400s: empty, binary, missing column, too many rows', () => {
    expect(() => parseImportFile(Buffer.alloc(0), 'physical', 'PKR')).toThrow(/empty/);
    expect(() => parseImportFile(Buffer.from('PK\u0003\u0004zipdata'), 'physical', 'PKR')).toThrow(/CSV/);
    expect(() => parseImportFile(buf('title,price', 'x,1'), 'physical', 'PKR')).toThrow(/Missing column/);
    const many = [HEAD, ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => GOOD.replace('Wooden', `Wooden ${i}`))];
    expect(() => parseImportFile(buf(...many), 'physical', 'PKR')).toThrow(/limit is 200/);
    expect(() => parseImportFile(buf(HEAD), 'physical', 'PKR')).toThrow(/at least one product row/);
  });
  it('exactly 200 rows is accepted', () => {
    const rows = [HEAD, ...Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => GOOD.replace('Wooden', `Wooden${i}`))];
    expect(parseImportFile(buf(...rows), 'physical', 'PKR').rows).toHaveLength(IMPORT_MAX_ROWS);
  });
  it('row numbers match the spreadsheet (header = row 1), unknown columns are listed, duplicates warn', () => {
    const p = parseImportFile(buf(HEAD + ',colour', GOOD + ',red', GOOD + ',blue', 'Abacus,,,,,,,,,,,'), 'physical', 'PKR');
    expect(p.ignoredColumns).toEqual(['colour']);
    expect(p.rows.map((r) => r.row)).toEqual([2, 3, 4]);
    expect(p.rows[1].warnings.join(' ')).toMatch(/Same title and price as row 2/);
    expect(p.rows[2].ok).toBe(false);
  });
  it('the template round-trips through the parser (its example row is valid)', () => {
    for (const type of ['physical', 'digital'] as const) {
      const p = parseImportFile(Buffer.from(importTemplateCsv(type)), type, 'PKR');
      expect(p.rows).toHaveLength(1);
      expect(p.rows[0].errors).toEqual([]);
    }
  });
});

describe('ProductImportService', () => {
  const make = (storeOk = true) => {
    const products: any = {
      addPhysicalProduct: jest.fn(async (_s: string, b: any) => {
        if (String(b.name).includes('Boom')) throw new BadRequestException('Your plan allows no more products');
        return { data: { product: { _id: 'p-' + b.name.length }, warnings: ['Only 1 image'] } };
      }),
      addDigitalProduct: jest.fn(),
    };
    const log = { log: jest.fn() };
    const db: any = { repositories: { storeModel: { findOne: () => ({ select: () => ({ lean: async () => (storeOk ? { baseCurrency: 'PKR', productTypes: ['physical_products'], status: 'active' } : null) }) }) } } };
    return { svc: new ProductImportService(db, products, log as any), products, log };
  };

  it('preview validates and writes nothing', async () => {
    const { svc, products } = make();
    const r: any = await svc.preview('s1', 'st1', 'physical', buf(HEAD, GOOD, 'Abacus,,,,,,,,,,'));
    expect(r.data).toMatchObject({ total: 2, valid: 1, invalid: 1 });
    expect(products.addPhysicalProduct).not.toHaveBeenCalled();
  });

  it('commit creates drafts, keeps going after a failure, and returns errors.csv for the failed rows only', async () => {
    const { svc, products, log } = make();
    const r: any = await svc.commit('s1', 'st1', 'physical', buf(HEAD, GOOD, GOOD.replace('Wooden', 'Boom'), 'Abacus,,,,,,,,,,'));
    expect(products.addPhysicalProduct).toHaveBeenCalledTimes(2);
    expect(products.addPhysicalProduct.mock.calls[0][1]).toMatchObject({ storeId: 'st1', status: 'draft' });
    expect(r.data.created).toHaveLength(1);
    expect(r.data.failed.map((f: any) => f.row)).toEqual([3, 4]);
    expect(r.data.failed[0].message).toMatch(/plan allows no more/);
    const lines = r.data.errorsCsv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('error');
    expect(log.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'products_imported', storeId: 'st1' }));
  });

  it("another seller's store (or a missing one) is refused before anything is read", async () => {
    const { svc, products } = make(false);
    await expect(svc.commit('s1', 'st1', 'physical', buf(HEAD, GOOD))).rejects.toThrow(/Store not found/);
    expect(products.addPhysicalProduct).not.toHaveBeenCalled();
  });
});
