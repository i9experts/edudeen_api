/**
 * Retires every live-class product (deliveryFormat 'live_class'). DRY-RUN by default: writes nothing.
 *
 *   npm run remove:live-classes            report only
 *   npm run remove:live-classes:apply      soft-delete (isDelete + inactive), pull from carts/wishlists, drop reminder logs
 *
 * Orders are NEVER touched (they are financial records). Buyers who paid for a class that has not happened yet
 * must be refunded by the owner first: --apply refuses while any exist, unless --allow-paid is passed too.
 */
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const ALLOW_PAID = process.argv.includes('--allow-paid');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const products = db.collection('products');
  const orders = db.collection('orders');

  const live = await products.find({ deliveryFormat: 'live_class' }, { projection: { name: 1, status: 1, isDelete: 1, storeId: 1, 'liveSession.startsAt': 1, 'liveSession.status': 1 } }).toArray();
  const ids = live.map(p => String(p._id));
  console.log(`Live-class products: ${live.length} (${live.filter(p => !p.isDelete).length} not deleted yet)`);
  const byStatus = new Map<string, number>();
  for (const p of live) byStatus.set(`${p.isDelete ? 'deleted/' : ''}${p.status}`, (byStatus.get(`${p.isDelete ? 'deleted/' : ''}${p.status}`) ?? 0) + 1);
  for (const [k, n] of byStatus) console.log(`  ${k}: ${n}`);

  // Paid, not cancelled/refunded lines per class; "upcoming" = the class has not started yet and was not cancelled.
  const paidOrders = ids.length
    ? await orders.find({ isDelete: false, isPaid: true, 'sellerOrders.items.productId': { $in: ids } }).project({ orderNumber: 1, userId: 1, 'sellerOrders.items.productId': 1, 'sellerOrders.items.status': 1, 'sellerOrders.items.name': 1 }).toArray()
    : [];
  const byProduct = new Map<string, Set<string>>();
  for (const o of paidOrders) for (const so of (o as any).sellerOrders ?? []) for (const it of so.items ?? []) {
    if (!ids.includes(String(it.productId)) || ['cancelled', 'refunded'].includes(it.status)) continue;
    if (!byProduct.has(String(it.productId))) byProduct.set(String(it.productId), new Set());
    byProduct.get(String(it.productId))!.add(String(o.userId));
  }
  let upcomingBuyers = 0;
  const now = Date.now();
  for (const p of live) {
    const buyers = byProduct.get(String(p._id))?.size ?? 0;
    if (!buyers) continue;
    const starts = p.liveSession?.startsAt ? new Date(p.liveSession.startsAt).getTime() : null;
    const upcoming = !!starts && starts > now && p.liveSession?.status !== 'cancelled';
    if (upcoming) upcomingBuyers += buyers;
    console.log(`  paid: "${p.name}" - ${buyers} buyer(s), ${upcoming ? 'UPCOMING (refund first)' : 'already held / cancelled'}`);
  }
  console.log(`Paid buyers of upcoming classes: ${upcomingBuyers}`);

  if (!APPLY) { console.log('\nDRY RUN - nothing was written. Re-run with :apply to retire them.'); await mongoose.disconnect(); return; }
  if (upcomingBuyers > 0 && !ALLOW_PAID) {
    console.error('\nREFUSED: paid buyers of upcoming classes exist. Refund them first (or pass --allow-paid).');
    await mongoose.disconnect(); process.exit(2);
  }

  const open = live.filter(p => !p.isDelete).map(p => String(p._id));
  const p1 = await products.updateMany({ deliveryFormat: 'live_class', isDelete: { $ne: true } }, { $set: { isDelete: true, status: 'inactive' } });
  const v = await db.collection('productvariants').updateMany({ productId: { $in: open }, isDelete: { $ne: true } }, { $set: { isDelete: true, isDefault: false } });
  const names = new Set((await db.listCollections().toArray()).map(c => c.name));
  const carts = names.has('carts') ? await db.collection('carts').updateMany({ 'items.productId': { $in: ids } }, { $pull: { items: { productId: { $in: ids } } } } as any) : null;
  const wish = names.has('wishlists') ? await db.collection('wishlists').deleteMany({ productId: { $in: ids } }) : null;
  const logs = names.has('live_reminder_logs') ? await db.collection('live_reminder_logs').deleteMany({}) : null;
  console.log(`\nAPPLIED: products ${p1.modifiedCount}, variants ${v.modifiedCount}, carts ${carts?.modifiedCount ?? 'n/a'}, wishlist rows ${wish?.deletedCount ?? 'n/a'}, reminder logs ${logs?.deletedCount ?? 'n/a'}`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
