/* eslint-disable prettier/prettier */
// Run by seller-overview.spec.ts in a plain node process (the mongodb driver's handshake fails inside
// Jest's sandbox). Starts a throw-away mongod, seeds orders, prints the computed numbers as JSON.
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { resolveDateRange } from './analytics-date.util';
import { customerSplit, sellerOverviewStats } from './order-aggregation.util';

const PKT = (s: string) => new Date(`${s}+05:00`); // wall-clock Pakistan time
const S = { 'sellerOrders.storeId': 'store1' };

const order = (userId: string, at: Date, o: Partial<{ subtotal: number; paid: boolean; claim: boolean; status: string }> = {}) => ({
  isDelete: false, userId, createdAt: at, isPaid: o.paid ?? true, isFreeClaim: o.claim ?? false, currency: 'PKR',
  sellerOrders: [{ storeId: 'store1', status: o.status ?? 'completed', subtotal: o.subtotal ?? 100, isPaid: o.paid ?? true, items: [] }],
});

async function main() {
  const bin = process.argv[2];
  const port: number = await new Promise((res) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
  const dbPath = mkdtempSync(join(tmpdir(), 'edudeen-mongo-'));
  const proc = spawn(bin, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/analytics_check`, { serverSelectionTimeoutMS: 1500 }); break; }
      catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const Order = mongoose.model('CheckOrder', new mongoose.Schema({}, { strict: false }), 'orders');
    const out: Record<string, any> = {};

    // 1) free claims / cancelled / unpaid
    const at = PKT('2020-03-10T12:00:00');
    await Order.insertMany([
      order('u1', at, { subtotal: 100 }),
      order('u2', at, { subtotal: 50, paid: false }),
      order('u3', at, { subtotal: 0, claim: true }),
      order('u4', at, { subtotal: 70, status: 'cancelled' }),
    ]);
    out.stats = await sellerOverviewStats(Order, PKT('2020-03-01T00:00:00'), PKT('2020-03-31T23:59:59'), S);

    // 2) inclusive end date
    await Order.deleteMany({});
    const r = resolveDateRange({ range: 'custom', from: '2020-03-01', to: '2020-03-03' }, { pkt: true });
    await Order.insertMany([
      order('u1', PKT('2020-03-03T23:30:00')), // last evening -> counted
      order('u2', PKT('2020-03-04T00:00:01')), // next PKT day -> not
      order('u3', PKT('2020-02-29T23:59:00')), // before -> not
      order('u4', PKT('2020-03-01T00:00:00')), // first second -> counted
    ]);
    out.inclusive = (await sellerOverviewStats(Order, r.from, r.to, S)).bookedCount;

    // 3) new vs returning
    await Order.deleteMany({});
    await Order.insertMany([
      order('u1', PKT('2020-03-26T10:00:00')),
      order('u2', PKT('2020-03-05T10:00:00')), order('u2', PKT('2020-03-27T10:00:00')),
      order('u3', PKT('2020-02-10T10:00:00')), order('u3', PKT('2020-03-28T10:00:00')),
      order('u4', PKT('2020-02-01T10:00:00'), { subtotal: 0, claim: true }), order('u4', PKT('2020-03-29T10:00:00')),
    ]);
    const d30 = resolveDateRange({ range: 'custom', from: '2020-03-01', to: '2020-03-30' }, { pkt: true });
    const d7 = resolveDateRange({ range: 'custom', from: '2020-03-24', to: '2020-03-30' }, { pkt: true });
    out.s30 = await customerSplit(Order, d30.from, d30.to, S);
    out.s7 = await customerSplit(Order, d7.from, d7.to, S);

    console.log('RESULT:' + JSON.stringify(out));
  } finally {
    await mongoose.disconnect().catch(() => undefined);
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(dbPath, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
