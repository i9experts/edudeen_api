/* eslint-disable prettier/prettier */
// Run by promotion-stats.spec.ts in a plain node process (mongodb driver handshake fails inside Jest).
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { promotionStats } from './promotion-stats.util';

const PKT = (s: string) => new Date(`${s}+05:00`);
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

const item = (o: any = {}) => ({ status: 'completed', couponDiscountUSD: 0, autoDiscountUSD: 0, campaignDiscountUSD: 0, ...o });
const pkg = (storeId: string, subtotal: number, items: any[], status = 'completed') => ({ storeId, status, subtotal, items });
const order = (at: Date, sellerOrders: any[], o: any = {}) => ({
  isDelete: false, isFreeClaim: false, paymentStatus: 'paid', createdAt: at, couponCode: null, sellerOrders, ...o,
});

async function main() {
  const bin = process.argv[2];
  const port: number = await new Promise((res) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
  const dbPath = mkdtempSync(join(tmpdir(), 'edudeen-mongo-'));
  const proc = spawn(bin, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/promo_check`, { serverSelectionTimeoutMS: 1500 }); break; }
      catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const Order = mongoose.model('PromoOrder', new mongoose.Schema({}, { strict: false }), 'orders');
    const out: Record<string, any> = {};
    const range = (d: number) => ({ from: daysAgo(d), to: NOW });
    const find = (rows: any[], kind: string, id: string) => rows.find((r) => r.kind === kind && r.id === id);

    await Order.insertMany([
      // coupon C1 (new order with couponId): 2 lines in one package -> one order, discount 30, revenue 200
      order(daysAgo(1), [pkg('s1', 200, [item({ couponId: 'C1', couponDiscountUSD: 10 }), item({ couponId: 'C1', couponDiscountUSD: 20 })])]),
      // coupon C1 again, 20 days ago (outside 7d, inside 30d)
      order(daysAgo(20), [pkg('s1', 100, [item({ couponId: 'C1', couponDiscountUSD: 5 })])]),
      // multi-store order: s1 package 300 uses coupon C1, s2 package 900 uses C2 and an automatic discount
      order(daysAgo(2), [
        pkg('s1', 300, [item({ couponId: 'C1', couponDiscountUSD: 15 })]),
        pkg('s2', 900, [item({ couponId: 'C2', couponDiscountUSD: 90 }), item({ autoDiscountId: 'A9', autoDiscountUSD: 7 })]),
      ]),
      // legacy order: no couponId, matched by order.couponCode (SAVE10 -> C1)
      order(daysAgo(3), [pkg('s1', 50, [item({ couponDiscountUSD: 4 })])], { couponCode: 'SAVE10' }),
      // automatic discount + platform sale for s1
      order(daysAgo(1), [pkg('s1', 80, [item({ autoDiscountId: 'A1', autoDiscountUSD: 8 }), item({ campaignId: 'CAM1', campaignDiscountUSD: 12 })])]),
      // excluded: cancelled package, cancelled line, refunded order, free claim, deleted
      order(daysAgo(1), [pkg('s1', 999, [item({ couponId: 'C1', couponDiscountUSD: 99 })], 'cancelled')]),
      order(daysAgo(1), [pkg('s1', 111, [item({ couponId: 'C1', couponDiscountUSD: 11, status: 'cancelled' })])]),
      order(daysAgo(1), [pkg('s1', 222, [item({ couponId: 'C1', couponDiscountUSD: 22 })])], { paymentStatus: 'refunded' }),
      order(daysAgo(1), [pkg('s1', 0, [item({ couponId: 'C1', couponDiscountUSD: 3 })])], { isFreeClaim: true }),
      order(daysAgo(1), [pkg('s1', 333, [item({ couponId: 'C1', couponDiscountUSD: 33 })])], { isDelete: true }),
    ]);

    const r30 = await promotionStats(Order as any, 's1', range(30).from, range(30).to, { SAVE10: 'C1' });
    const r7 = await promotionStats(Order as any, 's1', range(7).from, range(7).to, { SAVE10: 'C1' });
    const r2 = await promotionStats(Order as any, 's2', range(30).from, range(30).to, {});
    const other = await promotionStats(Order as any, 'nobody', range(30).from, range(30).to, { SAVE10: 'C1' });
    out.c1_30 = find(r30, 'coupon', 'C1');
    out.c1_7 = find(r7, 'coupon', 'C1');
    out.a1 = find(r30, 'discount', 'A1');
    out.cam1 = find(r30, 'sale', 'CAM1');
    out.s1_hasOtherStoreIds = r30.some((r) => ['C2', 'A9'].includes(r.id));
    out.s2 = r2.map((r) => `${r.kind}:${r.id}:${r.orders}:${r.discount}:${r.revenue}`).sort();
    out.other = other.length;

    console.log('RESULT:' + JSON.stringify(out));
  } finally {
    await mongoose.disconnect().catch(() => undefined);
    proc.kill();
    try { rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
