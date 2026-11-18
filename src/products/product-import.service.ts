/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { ProductsService } from './products.service';
import { ImportType, importErrorsCsv, importTemplateCsv, parseImportFile } from './product-import.util';

const errorText = (e: any): string => {
  const m = e?.response?.message ?? e?.message ?? 'Could not create this product';
  return Array.isArray(m) ? m.join(', ') : String(m);
};

/**
 * Seller CSV import. DRAFTS ONLY: a product needs photos / files that a spreadsheet cannot carry, and a draft skips every
 * publish rule, so nothing goes live from an import. Preview writes nothing; commit re-reads the SAME file and creates
 * each valid row through the normal create methods (plan limits, quality flags, duplicate warnings and all validation
 * run again there), one row at a time, so one bad row never stops the others.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly products: ProductsService,
    private readonly activityLog: ActivityLogService,
  ) {}

  template(type: ImportType): string {
    return importTemplateCsv(type);
  }

  private async ownStore(sellerId: string, storeId: string, type: ImportType) {
    if (!storeId) throw new BadRequestException('storeId is required');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('baseCurrency productTypes status').lean();
    if (!store) throw new BadRequestException('Store not found');
    if (!['active', 'pending'].includes(store.status)) throw new BadRequestException('Your store is not active');
    const types: string[] = store.productTypes ?? [];
    const allowed = type === 'physical'
      ? types.includes('physical_products') || types.includes('educational_resources')
      : types.includes('digital_downloads') || types.includes('educational_resources');
    if (!allowed) throw new BadRequestException(`Your store does not support ${type} products`);
    return store;
  }

  /** Validate every row; writes nothing. */
  async preview(sellerId: string, storeId: string, type: ImportType, buffer: Buffer) {
    const store = await this.ownStore(sellerId, storeId, type);
    const parsed = parseImportFile(buffer, type, store.baseCurrency);
    const valid = parsed.rows.filter((r) => r.ok).length;
    return {
      success: true,
      data: {
        type, total: parsed.rows.length, valid, invalid: parsed.rows.length - valid,
        ignoredColumns: parsed.ignoredColumns,
        rows: parsed.rows.map((r) => ({ row: r.row, title: r.title, ok: r.ok, errors: r.errors, warnings: r.warnings })),
      },
    };
  }

  /** Create the valid rows as drafts. Rows that fail (here or in the real create) come back with a reason + errors.csv. */
  async commit(sellerId: string, storeId: string, type: ImportType, buffer: Buffer) {
    const store = await this.ownStore(sellerId, storeId, type);
    const parsed = parseImportFile(buffer, type, store.baseCurrency);
    const failed: { row: number; title: string; message: string; cells: Record<string, string> }[] = [];
    const created: { row: number; title: string; productId: string; warnings: string[] }[] = [];

    for (const r of parsed.rows) {
      if (!r.ok || !r.body) {
        failed.push({ row: r.row, title: r.title, message: r.errors.map((e) => e.message).join('; '), cells: r.cells });
        continue;
      }
      try {
        const body = { ...r.body, storeId, status: 'draft' };
        const res: any = type === 'physical' ? await this.products.addPhysicalProduct(sellerId, body) : await this.products.addDigitalProduct(sellerId, body);
        created.push({ row: r.row, title: r.title, productId: String(res?.data?.product?._id ?? ''), warnings: [...r.warnings, ...(res?.data?.warnings ?? [])] });
      } catch (e: any) {
        failed.push({ row: r.row, title: r.title, message: errorText(e), cells: r.cells });
      }
    }

    await this.activityLog.log({
      storeId, category: 'products', action: 'products_imported',
      description: `CSV import: ${created.length} draft(s) created, ${failed.length} row(s) failed`,
      actorId: sellerId, actorRole: 'seller', targetType: 'store',
      metadata: { type, created: created.length, failed: failed.length },
    } as any);

    return {
      success: true,
      message: `${created.length} draft${created.length === 1 ? '' : 's'} created${failed.length ? `, ${failed.length} row${failed.length === 1 ? '' : 's'} need fixing` : ''}.`,
      data: {
        created, failed: failed.map((f) => ({ row: f.row, title: f.title, message: f.message })),
        // Only the rows that failed, in the template layout + an error column: fix them and upload this file again.
        errorsCsv: failed.length ? importErrorsCsv(type, failed) : null,
      },
    };
  }
}
