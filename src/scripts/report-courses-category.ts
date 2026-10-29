/**
 * READ-ONLY report: what sits under the 'Courses & Live Classes' category (and its sub-categories) before it is retired.
 * Writes nothing.
 *
 *   npm run report:courses-category
 */
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const cats = db.collection('categories');
  const products = db.collection('products');

  const mains = await cats.find({ name: { $regex: '^courses\\s*(&|and)\\s*live\\s*classes$', $options: 'i' }, isDelete: { $ne: true } }).toArray();
  if (!mains.length) { console.log('No "Courses & Live Classes" category found.'); await mongoose.disconnect(); return; }

  for (const main of mains) {
    const ids: string[] = [String(main._id)];
    for (let i = 0; i < ids.length; i++) {
      const kids = await cats.find({ parentId: ids[i], isDelete: { $ne: true } }).toArray();
      for (const k of kids) ids.push(String(k._id));
    }
    console.log(`\nCategory "${main.name}" (${main._id}) - ${ids.length - 1} sub-categories`);
    const q = { isDelete: { $ne: true }, $or: [{ categoryId: { $in: ids } }, { subCategoryId: { $in: ids } }] };
    const total = await products.countDocuments(q);
    console.log(`Products: ${total}`);
    const byFormat = await products.aggregate([{ $match: q }, { $group: { _id: { f: '$deliveryFormat', s: '$status' }, n: { $sum: 1 } } }]).toArray();
    for (const r of byFormat) console.log(`  format=${r._id.f ?? 'download'} status=${r._id.s}: ${r.n}`);
    const sample = await products.find(q, { projection: { name: 1, deliveryFormat: 1, status: 1 } }).limit(30).toArray();
    for (const p of sample) console.log(`  - ${p.name} [${p.deliveryFormat ?? 'download'}, ${p.status}]`);
  }
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
