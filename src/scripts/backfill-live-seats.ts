/**
 * Sets `liveSession.seatsTaken` on every live class to the number of seats really sold (paid, not cancelled / refunded orders)
 * and `liveSession.status` to 'scheduled' where it is missing. Only ever RAISES seatsTaken (never frees a seat), because unpaid
 * bank-transfer orders also hold a seat and are not visible in this count.
 * The checkout path already reconciles lazily on each purchase, so this is only to make seat counts correct up front.
 * DRY-RUN by default; writes products.liveSession.seatsTaken / status only.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/backfill-live-seats.ts           # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/backfill-live-seats.ts --apply   # writes
 */
import mongoose from 'mongoose';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const products: any[] = await db.collection('products')
    .find({ deliveryFormat: 'live_class', isDelete: { $ne: true } }, { projection: { name: 1, liveSession: 1 } }).toArray();
  let raise = 0, statusFix = 0;
  for (const p of products) {
    const id = String(p._id);
    const paid = await db.collection('orders').countDocuments({
      isDelete: false, isPaid: true,
      sellerOrders: { $elemMatch: { items: { $elemMatch: { productId: id, status: { $nin: ['cancelled', 'refunded'] } } } } },
    });
    const have = Number(p.liveSession?.seatsTaken) || 0;
    const set: Record<string, unknown> = {};
    if (paid > have) { set['liveSession.seatsTaken'] = paid; raise++; }
    if (!p.liveSession?.status) { set['liveSession.status'] = 'scheduled'; statusFix++; }
    if (!Object.keys(set).length) continue;
    console.log(`${p.name ?? id}: seatsTaken ${have} -> ${paid > have ? paid : have}${set['liveSession.status'] ? ', status -> scheduled' : ''}`);
    if (apply) await db.collection('products').updateOne({ _id: p._id }, { $set: set });
  }
  console.log(`${products.length} live classes checked; ${raise} seat counts raised, ${statusFix} statuses filled. ${apply ? 'APPLIED.' : 'Dry run - nothing written (add --apply).'}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
