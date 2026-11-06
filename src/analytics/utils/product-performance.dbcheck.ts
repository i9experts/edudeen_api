/* eslint-disable prettier/prettier */
// Run by product-performance.spec.ts in a plain node process (see seller-overview.dbcheck.ts for why).
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { sellerOverviewStats } from './order-aggregation.util';
import { freeToPaid, productSalesRows } from './product-performance.util';

const PKT = (s: string) => new Date(`${s}+05:00`);
const S = { 'sellerOrders.storeId': 'store1' };

type Item = { productId: string; totalPrice: number };
const order = (userId: string, at: string, o: { subtotal?: number; paid?: boolean; claim?: boolean; status?: string; items?: Item[]; store?: string } = {}) => ({
  isDelete: false, userId, createdAt: PKT(at), isPaid: o.paid ?? true, isFreeClaim: o.claim ?? false, currency: 'PKR',
  sellerOrders: [{ storeId: o.store ?? 'store1', status: o.status ?? 'completed', subtotal: o.subtotal ?? 100, isPaid: o.paid ?? true, items: o.items ?? [] }],
});

async function main() {
  const bin = process.argv[2];
  const port: number = await new Promise((res) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
  const dbPath = mkdtempSync(join(tmpdir(), 'edudeen-mongo-'));
  const proc = spawn(bin, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/product_check`, { serverSelectionTimeoutMS: 1500 }); break; }
      catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const Order = mongoose.model('CheckOrder', new mongoose.Schema({}, { strict: false }), 'orders');
    const out: Record<string, any> = {};
    const from = PKT('2020-03-01T00:00:00'), to = PKT('2020-03-31T23:59:59');

    // 1) revenue parity + free-claim separation
    await Order.insertMany([
      order('u1', '2020-03-10T12:00:00', { subtotal: 100, items: [{ productId: 'A', totalPrice: 60 }, { productId: 'B', totalPrice: 40 }] }),
      order('u2', '2020-03-11T12:00:00', { subtotal: 90, paid: false, items: [{ productId: 'A', totalPrice: 45 }, { productId: 'A', totalPrice: 45 }] }), // same product twice = 1 order
      order('u3', '2020-03-12T12:00:00', { subtotal: 0, claim: true, items: [{ productId: 'A', totalPrice: 0 }] }),
      order('u4', '2020-03-12T12:00:00', { subtotal: 70, status: 'cancelled', items: [{ productId: 'B', totalPrice: 70 }] }),
      order('u5', '2020-03-13T12:00:00', { subtotal: 55, items: [] }), // no item rows: still part of the total
      order('u6', '2020-03-13T12:00:00', { subtotal: 999, store: 'other', items: [{ productId: 'A', totalPrice: 999 }] }),
    ]);
    const sales = await productSalesRows(Order, from, to, S, PKT('2020-03-10T00:00:00'));
    const by = (id: string | null) => sales.rows.find((r) => r.productId === id);
    out.A = by('A'); out.B = by('B'); out.unallocated = by(null);
    out.totalRevenue = sales.totalRevenue;
    out.bookedValue = (await sellerOverviewStats(Order, from, to, S)).bookedValue;

    // 2) Free -> Paid
    await Order.deleteMany({});
    await Order.insertMany([
      order('c1', '2020-03-02T10:00:00', { subtotal: 0, claim: true }), order('c1', '2020-03-10T10:00:00', { subtotal: 80 }),   // pays in window
      order('c2', '2020-03-02T10:00:00', { subtotal: 0, claim: true }), order('c2', '2020-01-15T10:00:00', { subtotal: 80 }),   // paid BEFORE claim
      order('c3', '2020-03-02T10:00:00', { subtotal: 0, claim: true }), order('c3', '2020-05-20T10:00:00', { subtotal: 80 }),   // pays after 30 d, within 90 d
      order('c4', '2020-03-02T10:00:00', { subtotal: 0, claim: true }),                                                         // never pays
      order('c5', '2020-03-02T10:00:00', { subtotal: 0, claim: true }), order('c5', '2020-03-05T10:00:00', { subtotal: 80, paid: false }), // unpaid order
      order('c6', '2020-03-02T10:00:00', { subtotal: 0, claim: true }), order('c6', '2020-03-06T10:00:00', { subtotal: 80, status: 'cancelled' }),
      order('c7', '2020-03-02T10:00:00', { subtotal: 0, claim: true }), order('c7', '2020-03-08T10:00:00', { subtotal: 80, store: 'other' }), // paid another store
      order('c8', '2020-02-10T10:00:00', { subtotal: 0, claim: true }), order('c8', '2020-03-09T10:00:00', { subtotal: 80 }),   // first claim before the range: not in cohort
      order('c9', '2020-03-30T10:00:00', { subtotal: 0, claim: true }),                                                         // window still open at 15 Apr
    ]);
    const now = new Date('2020-06-01T00:00:00Z');
    out.f30 = await freeToPaid(Order, from, to, S, 30, now);
    out.f90 = await freeToPaid(Order, from, to, S, 90, now);
    out.fOpen = await freeToPaid(Order, from, to, S, 30, new Date('2020-04-15T00:00:00Z'));

    console.log('RESULT:' + JSON.stringify(out));
  } finally {
    await mongoose.disconnect().catch(() => undefined);
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(dbPath, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
