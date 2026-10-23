/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EXPORT_ROW_CAP, toExportCsv } from '../common/csv-export.util';
import { escapeRegex, parseDateParam, plainString, searchTerm } from '../common/query-safety.util';

export interface ExportActor { id?: string; name?: string | null }
type ExportKind = 'users' | 'orders' | 'listings' | 'payment_proofs';

const oneOf = (v: unknown, allowed: readonly string[]) => { const s = plainString(v); return s && allowed.includes(s) ? s : undefined; };
const day = (d: Date | undefined, end = false) => { if (!d) return undefined; const x = new Date(d); if (end) x.setHours(23, 59, 59, 999); return x; };
function dateRange(query: any) {
  const from = day(parseDateParam(query.from, 'from'));
  const to = day(parseDateParam(query.to, 'to'), true);
  if (!from && !to) return undefined;
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
}
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : '');

/**
 * Admin CSV exports (users, orders, listings, payment proofs). Each: newest first, capped at EXPORT_ROW_CAP rows (the
 * file says so when it was cut), cells formula-defused by `toExportCsv`, and every export leaves an audit entry.
 * Exports carry the minimum personal data needed (no passwords/OTP/tokens, no phone numbers, no bank details).
 */
@Injectable()
export class AdminExportsService {
  constructor(private readonly db: DatabaseService, private readonly activityLog: ActivityLogService) {}

  private get r() { return this.db.repositories; }

  private async finish(kind: ExportKind, header: string[], rows: unknown[][], query: any, actor?: ExportActor) {
    const out = toExportCsv(header, rows, { label: kind.replace('_', ' ') });
    // Awaited: the entry exists before the file leaves. If it cannot be written the export is refused (fail closed).
    const logged = await this.activityLog.logExport({ kind, rowCount: out.rowCount, truncated: out.truncated, filters: query, actor: { id: actor?.id, name: actor?.name, role: 'admin' } });
    if (!logged) throw new Error('Export refused: the audit entry could not be saved');
    return out.csv;
  }

  async users(query: any, actor?: ExportActor) {
    const role = oneOf(query.role, ['buyer', 'seller']);
    const status = plainString(query.status);
    const term = searchTerm(query.search);
    const range = dateRange(query);
    const match: Record<string, any> = { isDelete: false };
    if (status) match.status = status;
    if (term) { const rx = { $regex: escapeRegex(term), $options: 'i' }; match.$or = [{ name: rx }, { email: rx }]; }
    if (range) match.createdAt = range;
    const proj = { name: 1, email: 1, status: 1, createdAt: 1 };
    const take = (model: any, label: string) => model.find(match, proj).sort({ createdAt: -1 }).limit(EXPORT_ROW_CAP + 1).lean().then((a: any[]) => a.map((x) => ({ ...x, roleLabel: label })));
    const [buyers, sellers] = await Promise.all([
      role === 'seller' ? [] : take(this.r.userModel, 'buyer'),
      role === 'buyer' ? [] : take(this.r.sellerModel, 'seller'),
    ]);
    const all = [...buyers, ...sellers].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, EXPORT_ROW_CAP + 1);
    return this.finish('users', ['Id', 'Name', 'Email', 'Role', 'Status', 'Joined'], all.map((u) => [String(u._id), u.name, u.email, u.roleLabel, u.status, iso(u.createdAt)]), query, actor);
  }

  async orders(query: any, actor?: ExportActor) {
    const filter: Record<string, any> = { isDelete: { $ne: true } };
    const status = plainString(query.status); if (status) filter.orderStatus = status;
    const pay = plainString(query.paymentStatus); if (pay) filter.paymentStatus = pay;
    const type = plainString(query.paymentType); if (type) filter.paymentType = type;
    const range = dateRange(query); if (range) filter.createdAt = range;
    const orders: any[] = await this.r.orderModel.find(filter).sort({ createdAt: -1 }).limit(EXPORT_ROW_CAP + 1).lean();
    const buyers: any[] = await this.r.userModel.find({ _id: { $in: [...new Set(orders.map((o) => o.userId).filter(Boolean))] } }).select('name email').lean();
    const byId = new Map(buyers.map((b) => [String(b._id), b]));
    const rows = orders.map((o) => {
      const b = byId.get(String(o.userId));
      return [o.orderNumber ?? String(o._id), iso(o.createdAt), b?.name ?? '', b?.email ?? '', o.totalAmount, o.currency, o.paymentType, o.paymentStatus, o.orderStatus,
        (o.sellerOrders ?? []).reduce((n: number, s: any) => n + (s.items ?? []).reduce((m: number, i: any) => m + (i.quantity ?? 0), 0), 0)];
    });
    return this.finish('orders', ['Order', 'Placed', 'Buyer', 'Buyer email', 'Total', 'Currency', 'Payment type', 'Payment status', 'Order status', 'Items'], rows, query, actor);
  }

  async listings(query: any, actor?: ExportActor) {
    const filter: Record<string, any> = { isDelete: false };
    const status = plainString(query.status); if (status) filter.status = status;
    const term = searchTerm(query.search); if (term) filter.name = { $regex: escapeRegex(term), $options: 'i' };
    const range = dateRange(query); if (range) filter.createdAt = range;
    const products: any[] = await this.r.productModel.find(filter).sort({ createdAt: -1 }).limit(EXPORT_ROW_CAP + 1).lean();
    const stores: any[] = await this.r.storeModel.find({ _id: { $in: [...new Set(products.map((p) => p.storeId).filter(Boolean))] } }, { name: 1 }).lean();
    const storeName = new Map(stores.map((s) => [String(s._id), s.name]));
    const rows = products.map((p) => [String(p._id), p.name, storeName.get(String(p.storeId)) ?? '', p.status, p.isFeatured ? 'yes' : 'no', p.isTest ? 'yes' : 'no', p.purchaseCount ?? 0, (p.flags ?? []).join('|'), iso(p.createdAt)]);
    return this.finish('listings', ['Id', 'Title', 'Store', 'Status', 'Featured', 'Test', 'Sold', 'Flags', 'Created'], rows, query, actor);
  }

  async paymentProofs(query: any, actor?: ExportActor) {
    const filter: Record<string, any> = {};
    const status = oneOf(query.status, ['pending', 'approved', 'rejected']); if (status) filter.status = status;
    const range = dateRange(query); if (range) filter.createdAt = range;
    const proofs: any[] = await this.r.manualPaymentProofModel.find(filter).sort({ createdAt: -1 }).limit(EXPORT_ROW_CAP + 1).lean();
    const rows = proofs.map((p) => [String(p._id), iso(p.createdAt), p.status, p.amountUSD, p.amountPKR, p.transactionReference ?? '', p.senderName ?? '', p.checkoutId, p.reuploadCount ?? 0, iso(p.reviewedAt), p.rejectionReason ?? '']);
    return this.finish('payment_proofs', ['Id', 'Submitted', 'Status', 'Amount USD', 'Amount PKR', 'Reference', 'Sender', 'Checkout', 'Re-uploads', 'Reviewed', 'Rejection reason'], rows, query, actor);
  }
}
