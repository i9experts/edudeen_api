/* eslint-disable prettier/prettier */
// Run by dispatch.db.spec.ts in a plain node process (the mongodb driver cannot handshake inside Jest).
// Starts a throw-away mongod and checks that the Mongo due-date expression, the overdue filter and the
// urgency sort agree with the JS rule (dispatchDueAt / sellerShipBy) on seeded orders.
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { dispatchDueAt, dispatchDueExpr } from './dispatch.util';
import { sellerOrdersActionFilter, sellerShipBy, shipByUrgencySort } from '../store-dashboard/action-items.util';

async function main() {
  const bin = process.argv[2];
  const port: number = await new Promise((res) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
  const dbPath = mkdtempSync(join(tmpdir(), 'edudeen-mongo-'));
  const proc = spawn(bin, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/dispatch_check`, { serverSelectionTimeoutMS: 1500 }); break; }
      catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const Order = mongoose.model('DispatchOrder', new mongoose.Schema({}, { strict: false }), 'orders');
    const out: Record<string, any> = {};

    // 1) expression == JS for every weekday (14 consecutive days) x dispatchDays 1..7 x legacy
    const start = new Date('2026-11-09T07:00:00Z'); // Monday 12:00 PKT
    const rows: any[] = [];
    for (let d = 0; d < 14; d++) for (const n of [1, 2, 3, 4, 5, 6, 7, null]) {
      const base = new Date(start.getTime() + d * 86_400_000 + (d % 3) * 3_600_000 * 7);
      rows.push({ tag: 'expr', base, sellerOrders: [n === null ? { storeId: 'x' } : { storeId: 'x', dispatchDays: n }] });
    }
    await Order.insertMany(rows);
    const agg: any[] = await Order.aggregate([
      { $match: { tag: 'expr' } }, { $unwind: '$sellerOrders' },
      { $project: { base: 1, n: '$sellerOrders.dispatchDays', due: dispatchDueExpr('$sellerOrders', '$base') } },
    ]);
    let mismatches = 0;
    for (const r of agg) if (new Date(r.due).getTime() !== dispatchDueAt(r.base, r.n ?? null).getTime()) mismatches++;
    out.exprChecked = agg.length;
    out.exprMismatches = mismatches;

    // 2) overdue filter + sort == JS over seeded store orders
    const NOW = new Date('2026-11-16T09:00:00Z');
    const mk = (i: number, createdAt: Date, dispatchDays: number | null, extra: any = {}) => ({
      tag: 'store', isDelete: false, createdAt, isPaid: true, paymentType: 'stripe', paidAt: createdAt, isFreeClaim: false,
      sellerOrders: [{ storeId: 's1', fulfillmentType: 'physical', fulfillmentMode: 'seller', status: 'processing', ...(dispatchDays ? { dispatchDays } : {}), ...extra }],
      n: i,
    });
    const day = (s: string) => new Date(`${s}T07:00:00Z`);
    const seeded = [
      mk(1, day('2026-11-10'), 3),      // Tue + 3 working = Fri 13 -> overdue
      mk(2, day('2026-11-13'), 2),      // Fri + 2 = Mon 16 07:00Z, NOW 09:00Z -> overdue
      mk(3, day('2026-11-14'), 2),      // Sat + 2 = Tue 17 -> not yet
      mk(4, day('2026-11-12'), null),   // legacy: +48 h = Sat 14 -> overdue
      mk(5, day('2026-11-15'), null),   // legacy Sunday +48h = Tue 17 -> not yet
      mk(6, day('2026-11-09'), 7),      // Mon + 7 working = Tue 17 -> not yet
      mk(7, day('2026-11-02'), 1, { status: 'shipped' }), // shipped: never
      mk(8, day('2026-11-02'), 1, { fulfillmentMode: 'platform' }), // Edudeen ships: never
    ];
    await Order.insertMany(seeded);
    const base = { tag: 'store', 'sellerOrders.storeId': 's1' };
    const overdueMongo: any[] = await Order.find({ ...base, ...sellerOrdersActionFilter(['s1'], 'overdue', NOW) }).lean();
    const toshipMongo = await Order.countDocuments({ ...base, ...sellerOrdersActionFilter(['s1'], 'toship', NOW) });
    const all: any[] = await Order.find(base).lean();
    const jsOverdue = all.filter((o) => { const due = sellerShipBy(o, o.sellerOrders[0]); return due && due.getTime() <= NOW.getTime(); });
    out.overdueMongo = overdueMongo.map((o) => o.n).sort();
    out.overdueJs = jsOverdue.map((o) => o.n).sort();
    out.toshipMongo = toshipMongo;
    out.toshipJs = all.filter((o) => sellerShipBy(o, o.sellerOrders[0])).length;
    const sorted: any[] = await Order.aggregate([{ $match: base }, ...shipByUrgencySort(['s1'])]);
    out.sortMongo = sorted.map((o) => o.n);
    out.sortJs = [...all].sort((a, b) => {
      const da = sellerShipBy(a, a.sellerOrders[0])?.getTime() ?? Infinity;
      const db = sellerShipBy(b, b.sellerOrders[0])?.getTime() ?? Infinity;
      return da - db || b.createdAt.getTime() - a.createdAt.getTime();
    }).map((o) => o.n);

    // 3) scan bound: a store with 3000 finished orders and 50 waiting ones. With the schema index the overdue/to-ship
    //    query must examine about the waiting ones, not the whole history.
    await Order.collection.createIndex({ 'sellerOrders.storeId': 1 });
    await Order.collection.createIndex({ 'sellerOrders.storeId': 1, 'sellerOrders.status': 1 });
    const hist: any[] = [];
    for (let i = 0; i < 3050; i++) {
      const waiting = i < 50;
      const at = new Date(NOW.getTime() - (waiting ? 5 : 40 + (i % 50)) * 86_400_000);
      hist.push({ tag: 'big', isDelete: false, createdAt: at, isPaid: true, paymentType: 'stripe', paidAt: at, isFreeClaim: false,
        sellerOrders: [{ storeId: 's2', fulfillmentType: 'physical', fulfillmentMode: 'seller', status: waiting ? 'processing' : 'completed', dispatchDays: 2 }] });
    }
    await Order.insertMany(hist);
    const bigFilter = { 'sellerOrders.storeId': 's2', ...sellerOrdersActionFilter(['s2'], 'overdue', NOW) };
    const plan: any = await Order.find(bigFilter).explain('executionStats');
    out.bigOverdue = plan.executionStats.nReturned;
    out.bigDocsExamined = plan.executionStats.totalDocsExamined;
    out.bigTotal = 3050;

    console.log('RESULT:' + JSON.stringify(out));
  } finally {
    await mongoose.disconnect().catch(() => {});
    proc.kill();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
