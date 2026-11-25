/**
 * READ-ONLY report: buyers who hold more than one non-cancelled FREE order for the same digital product/course.
 * Writes nothing, deletes nothing - it only prints the groups so you can decide what to clean up.
 *
 *   npm run report:duplicate-free-orders
 *
 * Run it BEFORE adding any unique index on (userId, productId) for free claims - the build fails if duplicates exist.
 */
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const rawOrders = await db.collection('orders')
    .find(
      { isDelete: { $ne: true }, orderStatus: { $nin: ['cancelled', 'canceled'] }, $or: [{ isFreeClaim: true }, { paymentType: 'free' }] },
      { projection: { userId: 1, createdAt: 1, totalAmount: 1, orderStatus: 1, paymentStatus: 1, 'sellerOrders.items.productId': 1, 'sellerOrders.items.name': 1, 'sellerOrders.items.type': 1 } },
    )
    .toArray();

  const groups = new Map<string, { userId: string; productId: string; name: string; orders: any[] }>();
  const orders: any[] = rawOrders;
  for (const o of orders) {
    for (const so of o.sellerOrders ?? []) {
      for (const it of so.items ?? []) {
        if (it.type !== 'digital') continue;
        const key = `${o.userId}|${it.productId}`;
        const g = groups.get(key) ?? { userId: String(o.userId), productId: String(it.productId), name: it.name, orders: [] as any[] };
        if (!g.orders.some((x) => String(x._id) === String(o._id))) g.orders.push(o);
        groups.set(key, g);
      }
    }
  }

  let dupGroups = 0, extraOrders = 0;
  for (const g of groups.values()) {
    if (g.orders.length < 2) continue;
    dupGroups++;
    extraOrders += g.orders.length - 1;
    console.log(`\nbuyer ${g.userId} - "${g.name}" (${g.productId}) - ${g.orders.length} free orders:`);
    for (const o of g.orders.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))) {
      console.log(`   ${o._id}  ${new Date(o.createdAt).toISOString()}  status=${o.orderStatus}  payment=${o.paymentStatus}`);
    }
  }
  console.log(`\nChecked ${orders.length} free orders. ${dupGroups} buyer+product group(s) with duplicates, ${extraOrders} extra order(s). Nothing was changed.`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
